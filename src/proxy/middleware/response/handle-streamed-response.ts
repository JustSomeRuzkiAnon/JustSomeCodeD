import { Request, Response } from "express";
import * as http from "http";
import { buildFakeSseMessage } from "../common";
import { RawResponseBodyHandler, decodeResponseBody, reenqueueRequest } from ".";

const bytesRegex = /{"bytes":"([^"]+)"/g;

// reenqueueRequest(req);
// throw new RetryableError("Claude rate-limited request re-enqueued.");
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

type OpenAiChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string | null;
    index: number;
  }[];
};

type AnthropicCompletionResponse = {
  completion: string;
  stop_reason: string;
  truncated: boolean;
  stop: any;
  model: string;
  log_id: string;
  exception: null;
};

/**
 * Consume the SSE stream and forward events to the client. Once the stream is
 * stream is closed, resolve with the full response body so that subsequent
 * middleware can work with it.
 *
 * Typically we would only need of the raw response handlers to execute, but
 * in the event a streamed request results in a non-200 response, we need to
 * fall back to the non-streaming response handler so that the error handler
 * can inspect the error response.
 *
 * Currently most frontends don't support Anthropic streaming, so users can opt
 * to send requests for Claude models via an endpoint that accepts OpenAI-
 * compatible requests and translates the received Anthropic SSE events into
 * OpenAI ones, essentially pretending to be an OpenAI streaming API.
 */
 
// TODO: Streaming responses for Bison/Ai21 
export const handleStreamedResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {

  if (!req.isStreaming) {
    const err = new Error(
      "handleStreamedResponse called for non-streaming request."
    );
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }
  
  let isAnthropicChat = true 

  
  const key = req.key!;
  if (proxyRes.statusCode !== 200 || req.body.model.startsWith("dall-")) {
    // Ensure we use the non-streaming middleware stack since we won't be
    // getting any events.
    req.isStreaming = false;
    req.log.warn(
      { statusCode: proxyRes.statusCode, key: key.hash },
      `Streaming request returned error status code. Falling back to non-streaming response handler.`
    );
    return decodeResponseBody(proxyRes, req, res);
  }

  return new Promise((resolve, reject) => {
    req.log.info({ key: key.hash }, `Starting to proxy SSE stream.`);

    // Queued streaming requests will already have a connection open and headers
    // sent due to the heartbeat handler.  In that case we can just start
    // streaming the response without sending headers.
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      copyHeaders(proxyRes, res);
      res.flushHeaders();
    }

    const originalEvents: string[] = [];
    let partialMessage = "";
	let completionParts: string[] = [];
	let fullMessage = ""; //For anthropic token counting 
    let lastPosition = 0;
	let awsInitialize = true;
	let isFirstThought = false
	const isAWS = req.key?.isAws;
	const isAnthropic = isAnthropicChat && req.key?.service === "anthropic";
	const isOpenAI = req.key?.service === "openai";
	const isGrok = req.key?.service === "grok";
	const isDeepseek = req.key?.service === "deepseek";
	const isCohere = req.key?.service === "cohere";
	const isGoogle = req.key?.service === "google";
	const isMistral = req.key?.service === "mistral";
	const isGoogleOpenai = req.key?.service === "google" && req.inboundApi === "openai";

    type ProxyResHandler<T extends unknown> = (...args: T[]) => void;
	
	
    function withErrorHandling<T extends unknown>(fn: ProxyResHandler<T>) {
      return (...args: T[]) => {
        try {
          fn(...args);
        } catch (error) {
			if (isAWS) {
				reenqueueRequest(req);
				throw new RetryableError("Claude rate-limited request re-enqueued.");
			}
      throw new Error(error);
		}
      };
    }
	

    proxyRes.on(
	  "data",
	  withErrorHandling((chunk: Buffer) => {
		const str = chunk.toString();	
	    
		if (isAWS) {
		  if (str.includes('{"message":"Validation Error"}')) {
		    proxyRes.emit("full-sse-event", "event: message_start\n" + 'data: {"choices":[{"index":0,"message":{"role":"assistant","content":"```Bad request error: Mistral AWS requires first prompt sent CANNOT be with role assistant it must be user/system role, and the latest message sent needs to have role of user.```"},"stop_reason":null}]}')
			}

		  const fullMessages = (partialMessage + str).split("\"}").map(message => message + "\"}");
		  if (str.includes("{\"") && str.includes("\"}")) {
			partialMessage = "";
			for (const m of str.matchAll(bytesRegex) || []) {
			  const payload = "data: " + Buffer.from(m[1], 'base64').toString('utf-8');
			  const decodedPayload = JSON.parse(payload.slice(6));
			  if (decodedPayload.type == "message_start") {
			     decodedPayload.message.id = "msg_itsveryfunnyid"
			  }
			  if (awsInitialize) {
				awsInitialize = false;
				proxyRes.emit("full-sse-event", "event: message_start\n" + payload);
			  } else {
				proxyRes.emit("full-sse-event", "event: content_block_delta\n" + payload);
			  }
			  completionParts.push(decodedPayload["completion"]);
			  fullMessage = completionParts.join('');
			  if (decodedPayload["stop_reason"] != null) {
				decodedPayload["completion"] = fullMessage;
				resolve(decodedPayload);
			  }
			}
		  } else {
			partialMessage += str;
		  }
		} else if (isAnthropic) {
		  const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/);
		  partialMessage = fullMessages.pop() || "";
		  fullMessages.forEach(msg => {
			if (msg.startsWith('event:')) {
			  const payload = JSON.parse(msg.split("data: ")[1]);
			  if (payload["type"] === "message_stop") {
				proxyRes.emit("full-sse-event", "data: [DONE]");
				resolve(payload);
			  } else {
				proxyRes.emit("full-sse-event", msg);
			  }
			}
		  });
		} else if (isCohere) { 
			const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/);
			partialMessage = fullMessages.pop() || "";
			fullMessages.forEach((message) => {
				if (message.includes('data:')) {
					try {
						const dataPart = message.split("\n").find(line => line.startsWith("data:"));
						if (dataPart !== undefined) {
							const jsonObject = JSON.parse(dataPart.slice(6));
							let content = jsonObject["delta"]["message"]["content"]["text"]
							if (content !== undefined) {
								jsonObject["choices"] = [ {"index":0,"delta":{"content":`${content}`}} ]
								proxyRes.emit("full-sse-event", `event: content-delta`);
								proxyRes.emit("full-sse-event", `data: ${JSON.stringify(jsonObject)}`);
							} else {
								proxyRes.emit("full-sse-event", message);
							}
						} else {
							proxyRes.emit("full-sse-event", message);
						}
					} catch {
						proxyRes.emit("full-sse-event", message);
					}
				} else {
					proxyRes.emit("full-sse-event", message);
				}
			});
			
		} else if (isOpenAI || isDeepseek) {
		  const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/);
		  partialMessage = fullMessages.pop() || "";
		  fullMessages.forEach((message) => {
			if (isDeepseek) {
				if (message.includes('"delta":{"content":null')) {
					let jsonObject = JSON.parse(message.slice(6));
					const thought = jsonObject["choices"][0]["delta"]["reasoning_content"];
					if (!isFirstThought) {
						isFirstThought = true;
						jsonObject["choices"][0]["delta"]["content"] = "<thought>"+thought
						proxyRes.emit("full-sse-event", `data: ${JSON.stringify(jsonObject)}`);
					} else {
						jsonObject["choices"][0]["delta"]["content"] = thought
						proxyRes.emit("full-sse-event", `data: ${JSON.stringify(jsonObject)}`);
					}
					
				} else if (isDeepseek && isFirstThought && message.includes('"reasoning_content":null}')) {
					isFirstThought = false 
					let jsonObject = JSON.parse(message.slice(6));
					jsonObject["choices"][0]["delta"]["content"] = "</thought>"+jsonObject["choices"][0]["delta"]["content"]
					proxyRes.emit("full-sse-event", `data: ${JSON.stringify(jsonObject)}`);
				} else {
					proxyRes.emit("full-sse-event", message);
				}
			} else {
				proxyRes.emit("full-sse-event", message);
			}
		
			
		});
		  
		  
		} else if (isGoogleOpenai) {
		  const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/);
		  partialMessage = fullMessages.pop() || "";
		  fullMessages.forEach(message => {
			try {
			  const payload = JSON.parse(message.split("data: ")[1]);
			  proxyRes.emit("full-sse-event", payload["candidates"][0]["content"]["parts"][0]["text"]);
			} catch {
			  try {
				const payload = JSON.parse(message.split("data: ")[1]);
				proxyRes.emit("full-sse-event", "Scylla is disgusted with you, and to protect the key she blocked your prompt.\n```<q>" + "</q>Reason: <q>" + payload["</q>promptFeedback<q>"]["</q>blockReason<q>"] + "</q>```");
			  } catch {}
			}
		  });
		} else if (isGoogle) { 
			if (str.startsWith('data: {"promptFeedback": {"blockReason": "') || str.includes('"finishReason": "OTHER",')) {
				const jsonObject = JSON.parse(str.slice(6));
				const formattedString = JSON.stringify(jsonObject, null, 4).replace(/\r|\n/g, '\\n').replace(/\"|\'/g, '');
				proxyRes.emit("full-sse-event", 
				'data: {"candidates": [{"content": {"parts": [{"text": " Blocked by google reason: \\n```json\\n'+formattedString+'\\n```"}],"role": "model"},"index": 0,"safetyRatings": [{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT","probability": "HIGH"},{"category": "HARM_CATEGORY_HATE_SPEECH","probability": "NEGLIGIBLE"},{"category": "HARM_CATEGORY_HARASSMENT","probability": "NEGLIGIBLE"},{"category": "HARM_CATEGORY_DANGEROUS_CONTENT","probability": "NEGLIGIBLE"}]}],"usageMetadata": {"promptTokenCount": 5,"candidatesTokenCount": 5,"totalTokenCount": 5},"modelVersion": "gemini-pro"}'
				)
			} else {
				if (typeof str === 'string') {
					const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/).filter(message => message !== "");
					if (str.trim().endsWith("\"}")) {
						partialMessage = "";
						fullMessages.forEach(message => proxyRes.emit("full-sse-event", message));
						fullMessage += str;
					} else {
						partialMessage += str;
					}
				}
				
				
			}
		} else if (isMistral) { 
			proxyRes.emit("full-sse-event", chunk);
		} else {
		  const fullMessages = (partialMessage + str).split(/\r?\n\r?\n/).filter(message => message !== "");
		  if (str.startsWith("event: completion") && str.trim().endsWith("\"}")) {
			partialMessage = "";
			fullMessages.forEach(message => proxyRes.emit("full-sse-event", message));
			fullMessage += JSON.parse(str.split("\n")[1].split("data: ")[1])["completion"];
		  } else {
			partialMessage += str;
		  }
		}
	  })
	);



    proxyRes.on(
      "full-sse-event",
      withErrorHandling((data) => {
        originalEvents.push(data);
        const { event, position } = transformEvent({
          data,
          requestApi: req.inboundApi,
          responseApi: req.outboundApi,
          lastPosition,
        });
        lastPosition = position;
        res.write(event + "\n\n");
      })
    );

    proxyRes.on(
      "end",
      withErrorHandling(() => {
		if (isGoogle) {
			req.log.info({ key: key.hash }, `Finished proxying SSE stream.`);
			res.end();
		} else if (isMistral) {
			req.log.info({ key: key.hash }, `Finished proxying SSE stream.`);
			res.end();
		} else {
			let finalBody = convertEventsToFinalResponse(originalEvents, req);
			if ('completion' in finalBody) {
				finalBody["completion"] = fullMessage;
			};
			req.log.info({ key: key.hash }, `Finished proxying SSE stream.`);
			res.end();
			
			resolve(finalBody);
		}
      })
    );

    proxyRes.on("error", (err) => {
      req.log.error({ error: err, key: key.hash }, `Mid-stream error.`);
      const fakeErrorEvent = buildFakeSseMessage(
        "mid-stream-error",
        err.message,
        req
      );
      res.write(`data: ${JSON.stringify(fakeErrorEvent)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      reject(err);
    });
  });
};

/**
 * Transforms SSE events from the given response API into events compatible with
 * the API requested by the client.
 */
function transformEvent({
  data,
  requestApi,
  responseApi,
  lastPosition,
}: {
  data: string;
  requestApi: string;
  responseApi: string;
  lastPosition: number;
}) {

  if (responseApi === "grok" || responseApi === "deepseek" ) {
	responseApi = "openai"
  }
 
  if (requestApi === responseApi) {
    return { position: -1, event: data };
  }
  
  if (requestApi == "openai" && responseApi == "google") {
	let currentReason = null;
	if (data === "data: [DONE]") {
		data = "";
		currentReason = "message_stop";
	}
	
	const newEvent = {
		id: "chatcmpl-" + Date.now().toString(),
		object: "chat.completion.chunk",
		created: Date.now(),
		model: "google",
		choices: [
		  {
			index: 0,
			delta: { "content": data || ""},
			finish_reason: currentReason
		  },
		],
	  };
	  
	return { position: -1, event: `data: ${JSON.stringify(newEvent)}`, };
	
  }
  
  if (requestApi == "openai" && responseApi == "cohere"){
	let currentReason = null;
	if (data !== "data: [DONE]") {
		return { position: -1, event: data };
	} else {
		data = "";
		currentReason = "message_stop";
		const newEvent = {
			id: "chatcmpl-" + Date.now().toString(),
			object: "chat.completion.chunk",
			created: Date.now(),
			model: "cohere",
			choices: [
			  {
				index: 0,
				delta: { "content": data || ""},
				finish_reason: currentReason
			  },
			],
		  };
		return { position: -1, event: `data: ${JSON.stringify(newEvent)}\ndata: [DONE]`, };
	}
  }
  
  if (requestApi == "openai" && responseApi == "anthropic"){
	let currentReason = null;
	if (data === "data: [DONE]") {
		data = "";
		currentReason = "message_stop";
	}
  
	const newEvent = {
		id: "chatcmpl-" + Date.now().toString(),
		object: "chat.completion.chunk",
		created: Date.now(),
		model: "claude",
		choices: [
		  {
			index: 0,
			delta: { "content": data || ""},
			finish_reason: currentReason
		  },
		],
	  };
	  
	return { position: -1, event: `data: ${JSON.stringify(newEvent)}\ndata: [DONE]`, };
  }

  // Anthropic sends the full completion so far with each event whereas OpenAI
  // only sends the delta. To make the SSE events compatible, we remove
  // everything before `lastPosition` from the completion.
  if (!data.startsWith("data:")) {
    return { position: lastPosition, event: data };
  }

  if (data.startsWith("data: [DONE]")) {
    return { position: lastPosition, event: data };
  }

  const event = JSON.parse(data.slice("data: ".length));
  
  
  const newEvent = {
    id: "ant-" + event.log_id,
    object: "chat.completion.chunk",
    created: Date.now(),
    model: event.model,
    choices: [
      {
        index: 0,
        delta: { content: event.completion?.slice(lastPosition) },
        finish_reason: event.stop_reason,
      },
    ],
  };
  return {
    position: event.completion.length,
    event: `data: ${JSON.stringify(newEvent)}`,
  };
}

/** Copy headers, excluding ones we're already setting for the SSE response. */
function copyHeaders(proxyRes: http.IncomingMessage, res: Response) {
  const toOmit = [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-type",
    "connection",
    "cache-control",
  ];
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    if (!toOmit.includes(key) && value) {
      res.setHeader(key, value);
    }
  }
}

/**
 * Converts the list of incremental SSE events into an object that resembles a
 * full, non-streamed response from the API so that subsequent middleware can
 * operate on it as if it were a normal response.
 * Events are expected to be in the format they were received from the API.
 */
function convertEventsToFinalResponse(events: string[], req: Request) {
  if ( req.outboundApi === "cohere" || req.outboundApi === "deepseek" || req.outboundApi === "openai" || (req.outboundApi === "google" && req.inboundApi === "openai") ) {
    let response: OpenAiChatCompletionResponse = {
      id: "",
      object: "",
      created: 0,
      model: "",
      choices: [],
    };
    response = events.reduce((acc, event, i) => {
      if (!event.startsWith("data: ")) {
        return acc;
      }

      if (event === "data: [DONE]") {
        return acc;
      }

      const data = JSON.parse(event.slice("data: ".length));
	  if (i === 0) {
		return {
		  id: data.id,
		  object: data.object,
		  created: data.created,
		  model: data.model,
		  choices: [
			{
			  message: { role: data.choices[0]?.delta?.role || "assistant", content: "" },
			  index: 0,
			  finish_reason: null,
			},
		  ],
		};
	  }
	
	  if (data.choices[0].delta) {
		  if (data.choices[0].delta.content) {
			acc.choices[0].message.content += data.choices[0].delta.content;
		  }
	  }
      acc.choices[0].finish_reason = data.choices[0].finish_reason;
      return acc;
    }, response);
	
    return response;
  }
  
  
  if (req.outboundApi === "anthropic") {
    /*
     * Full complete responses from Anthropic are conveniently just the same as
     * the final SSE event before the "DONE" event, so we can reuse that
     */

    const lastEvent = events[events.length - 2].toString();
    const data = JSON.parse(lastEvent.slice(lastEvent.indexOf("data: ") + "data: ".length));
    const response: AnthropicCompletionResponse = {
      ...data,
      log_id: req.id,
    };
    return response;
  }
  throw new Error("If you get this, something is fucked");
}
