/* This file is fucking horrendous, sorry */
import { Request, Response } from "express";
import * as http from "http";
import util from "util";
import zlib from "zlib";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { keyPool } from "../../../key-management";
import { enqueue, trackWaitTime } from "../../queue";
import { incrementPromptCount, incrementTokenCount, incrementGlobalTokenCount } from "../../auth/user-store";
import { isCompletionRequest, writeErrorResponse } from "../common";
import { handleStreamedResponse } from "./handle-streamed-response";
import { OpenAIPromptMessage, countTokens } from "../../../tokenization";
import { AIService } from "../../../key-management"
import axios, { AxiosError } from "axios";

const DECODER_MAP = {
  gzip: util.promisify(zlib.gunzip),
  deflate: util.promisify(zlib.inflate),
  br: util.promisify(zlib.brotliDecompress),
};

const isSupportedContentEncoding = (
  contentEncoding: string
): contentEncoding is keyof typeof DECODER_MAP => {
  return contentEncoding in DECODER_MAP;
};

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * Either decodes or streams the entire response body and then passes it as the
 * last argument to the rest of the middleware stack.
 */
export type RawResponseBodyHandler = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => Promise<string | Record<string, any>>;
export type ProxyResHandlerWithBody = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response,
  /**
   * This will be a Buffer if the response contains binary data,
   * an object if the response content-type is application/json,
   * or it will be a string for other content types.
   */
  body: string | Record<string, any>
) => Promise<void>;
export type ProxyResMiddleware = ProxyResHandlerWithBody[];

/**
 * Returns a on.proxyRes handler that executes the given middleware stack after
 * the common proxy response handlers have processed the response and decoded
 * the body.  Custom middleware won't execute if the response is determined to
 * be an error from the upstream service as the response will be taken over by
 * the common error handler.
 *
 * For streaming responses, the handleStream middleware will block remaining
 * middleware from executing as it consumes the stream and forwards events to
 * the client. Once the stream is closed, the finalized body will be attached
 * to res.body and the remaining middleware will execute.
 */
 
export const createOnProxyResHandler = (apiMiddleware: ProxyResMiddleware) => {
  return async (
    proxyRes: http.IncomingMessage,
    req: Request,
    res: Response
  ) => {
    const initialHandler = req.isStreaming
      ? handleStreamedResponse
      : decodeResponseBody;

    let lastMiddlewareName = initialHandler.name;

    try {
      const body = await initialHandler(proxyRes, req, res);
     
      const middlewareStack: ProxyResMiddleware = [];

      if (req.isStreaming) {
        // `handleStreamedResponse` writes to the response and ends it, so
        // we can only execute middleware that doesn't write to the response.
        middlewareStack.push(trackRateLimit, incrementKeyUsage, CountTokenPrompt);
      } else {
        middlewareStack.push(
          trackRateLimit,
          handleUpstreamErrors,
          incrementKeyUsage,
          copyHttpHeaders,
          CountTokenPrompt,
          ...apiMiddleware
        );
      }

      for (const middleware of middlewareStack) {
        lastMiddlewareName = middleware.name;
        await middleware(proxyRes, req, res, body);
      }

      trackWaitTime(req);
    } catch (error: any) {
      // Hack: if the error is a retryable rate-limit error, the request has
      // been re-enqueued and we can just return without doing anything else.
      if (error instanceof RetryableError) {
        return;
      }

      const errorData = {
        error: error.stack,
        thrownBy: lastMiddlewareName,
        key: req.key?.hash,
      };
	  
      const message = `Error while executing proxy response middleware: ${lastMiddlewareName} (${error.message})`;
      if (res.headersSent) {
        req.log.error(errorData, message);
        // This should have already been handled by the error handler, but
        // just in case...
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      logger.error(errorData, message)
      res.status(500).json({ error: "Internal server error", proxy_note: message });
    }
  };
};

export function reenqueueRequest(req: Request) {
  req.log.info(
    { key: req.key?.hash, retryCount: req.retryCount },
    `Re-enqueueing request due to retryable error`
  );
  req.retryCount++;
  enqueue(req);
}


/**
 * Handles the response from the upstream service and decodes the body if
 * necessary.  If the response is JSON, it will be parsed and returned as an
 * object.  Otherwise, it will be returned as a string.
 * @throws {Error} Unsupported content-encoding or invalid application/json body
 */
export const decodeResponseBody: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  if (req.isStreaming) {
    const err = new Error("decodeResponseBody called for a streaming request.");
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }
  
  

  const promise = new Promise<Buffer | string | Record<string, any>>((resolve, reject) => {
    let chunks: Buffer[] = [];
	
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", async () => {
      let body = Buffer.concat(chunks);
      const contentEncoding = proxyRes.headers["content-encoding"]

      if (contentEncoding) {
        if (isSupportedContentEncoding(contentEncoding)) {
          const decoder = DECODER_MAP[contentEncoding];
          body = await decoder(body);
        } else {
          const errorMessage = `Proxy received response with unsupported content-encoding: ${contentEncoding}`;
          logger.warn({ contentEncoding, key: req.key?.hash }, errorMessage);
          writeErrorResponse(req, res, 500, {
            error: errorMessage,
            contentEncoding,
          });
          return reject(errorMessage);
        }
      }

      try {
        if (proxyRes.headers["content-type"]?.includes("application/json")) {
          const json = JSON.parse(body.toString());
		  
		  if (req.body.model.includes("gemini") && req.body.model.includes("thinking")) {
			const parts = json.candidates[0].content.parts;

			let combinedText = '';

			// Use inline type annotation for 'part'
			parts.forEach((part: { text: string; thought?: boolean }) => {
				if (part.thought) {
					combinedText += `<thought>${part.text}</thought>`;
				} else {
					combinedText += part.text;
				}
			});

			json.candidates[0].content.parts = [{
				text: combinedText
			}];
		}
		  
		  if (req.key?.isAws) {
			json.id = "msg_itsveryfunnyid"
		  } 
		  
		  if (req.body.model.startsWith("dall-")) {
			const key = config.imgBBKey?.toString() ?? ""
			const expiration = config.ImageExpiry?.toString() ?? "604800"

			const image = json.data[0].b64_json.replace(/^data:image\/(png|jpg);base64,/, "");
			
			const formData = new FormData();
			formData.append("key", key);
			formData.append("expiration", expiration);
			formData.append("image", image); // Ensure 'image' is a File object or Blob
			const response = await axios.post(`https://api.imgbb.com/1/upload`, formData, { headers: { 'content-type': 'multipart/form-data' } });
			const is_streaming = json.data[0].stream
			delete json.data[0].b64_json
			delete json.data[0].stream
			
			// No idea how to make streaming work (in simple way) so for now it is non streaming only 
			json.data[0].url = response.data.data.url
			if (req.route.path == "/v1/chat/completions") {
				const image_url = json.data[0].url 
				const revised_prompt = json.data[0].revised_prompt
				if (is_streaming) {
					const chat_str = {
					id:"chatcmpl-123",
					object:"chat.completion.chunk",
					created:1726076570,
					model:"dall-3",
					system_fingerprint:"fp_123",
					choices:[{
						index:0,
						delta:{ 
							role:"assistant",
							content:`Revised prompt: ${revised_prompt}\n\n![](${image_url})`,refusal:null
							},
						logprobs:null,
						finish_reason:"length"
						}]
						}
					const chat_json = JSON.parse(JSON.stringify(chat_str))
					return resolve(`data: ${chat_json}\n\n` + `data: [DONE]`);
				} else {
					const chat_str = { choices: [
						{finish_reason: "stop",index: 0,
						 message: {content: `Revised prompt: ${revised_prompt}\n\n![](${image_url})`,
						role: "assistant"},
						logprobs: null    }  ],
						created: 1677664795,
						id: "chatcmpl-7QyqpwdfhqwajicIEznoc6Q47XAyW",
						model: "dall-e",
						object: "chat.completion",
						usage: {"completion_tokens": 17,"prompt_tokens": 57,"total_tokens": 74  }
					
					}
					const chat_json = JSON.parse(JSON.stringify(chat_str))
					return resolve(chat_json);
				}
			} if (req.route.path === "/v1/audio/speech") {
				// For '/v1/audio/speech', return the binary data as-is
				return resolve(body);
			}	else {
				json.data[0].url = response.data.data.url
			}
			
			
		  }
		  
		  return resolve(json);
		}
        return resolve(body);
      } catch (error: any) {
        const errorMessage = `Proxy received response with invalid JSON: ${error.message}`;
        logger.warn({ error, key: req.key?.hash }, errorMessage);
        writeErrorResponse(req, res, 500, { error: errorMessage });
        return reject(errorMessage);
      }
    });
  });
  return promise;
};


const getPromptForRequest = (req: Request): string | OaiMessage[] => {
  // Since the prompt logger only runs after the request has been proxied, we
  // can assume the body has already been transformed to the target API's
  // format.
  if (req.outboundApi === "anthropic") {
    return req.body.messages;
  } 
  if (req.outboundApi === "google") {
    return req.body.candidates[0]?.content.parts;
  } 
  if (req.outboundApi === "ai21") {
    return req.body.completions[0].data.text;
  }  else {
    return req.body.messages;
  }
};
const getResponseForService = ({
  service,
  body,
}: {
  service: AIService;
  body: Record<string, any>;
}): { completion: string; model: string } => {
  if (service === "anthropic") {
    return { completion: body.completion.trim(), model: body.model };
  } else if (service === "google") {
	return { completion: (body.candidates[0]?.content.parts[0]?.text ?? "Report to drago :|"), model: body.model };
  } else if (service === "ai21") {
	return { completion: body.completions[0].data.text, model: body.model };
  }else {
    return { completion: body.choices[0].message.content, model: body.model };
  }
};

type OaiMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  tool_calls: {
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: 'function';
  }[];
};
type TokenCountRequest = {
  req: Request;
} & (
  | { prompt: string; service: "anthropic" }
  | { prompt: OpenAIPromptMessage[]; service: "openai" }
);

export const CountTokenPrompt: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (req.body.model.startsWith("dall") || req.body.voice != undefined) {
	return 
  }
	
  if (typeof responseBody !== "object") {
    throw new Error("Expected body to be an object");
  }
  if (!isCompletionRequest(req)) {
    return;
  }
    
  // Disable token counting for proxy_key ;v claude doesn't work with it >_<
  // idc if it's not tottaly accurate roughlt it's right... 
  if (req.outboundApi == "openai") {
  
	  const promptPayload: OpenAIPromptMessage[] = Array.isArray(getPromptForRequest(req))
	  ? (getPromptForRequest(req) as OaiMessage[]).map((message: OaiMessage) => ({ content: message.content, role: message.role || "user", tool_calls: message.tool_calls }))
	  : [{ content: getPromptForRequest(req) as string, role: "user" }];
	  
	  const request: TokenCountRequest = {
		  req: req,
		  prompt: promptPayload,
		  service: "openai"
		};
	  const tokenCount = await countTokens(request);
	  
	  const outputRequest: TokenCountRequest = {
		  req: req,
		  prompt: [responseBody.choices[0].message],
		  service: "openai"
		};
	  const outputTokenCount = await countTokens(outputRequest);
	  
	  incrementGlobalTokenCount(tokenCount.token_count,"openai");
	  
	  if (config.gatekeeper == "user_token") {
		  if (req.user !== undefined) {
	         incrementTokenCount(req.user.token, tokenCount.token_count, "openai", req.body.model, outputTokenCount.token_count);
		  }
	  }
  } 
  
};

// TODO: This is too specific to OpenAI's error responses.
/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * On 429 errors, if request queueing is enabled, the request will be silently
 * re-enqueued.  Otherwise, the request will be rejected with an error payload.
 * @throws {Error} On HTTP error status code from upstream service
 */
const handleUpstreamErrors: ProxyResHandlerWithBody = async (
  proxyRes,
  req,
  res,
  body
) => {
  const statusCode = proxyRes.statusCode || 500;
  
  
  if (statusCode < 400) {
    return;
  }

  let errorPayload: Record<string, any>;
  // Subtract 1 from available keys because if this message is being shown,
  // it's because the key is about to be disabled.
  const availableKeys = keyPool.available(req.outboundApi) - 1;
  const tryAgainMessage = Boolean(availableKeys)
    ? `There are ${availableKeys} more keys available; try your request again.`
    : "There are no more keys available.";

  try {
    if (typeof body === "object") {
      errorPayload = body;
    } else {
      throw new Error("Received unparsable error response from upstream.");
    }
  } catch (parseError: any) {
    const statusMessage = proxyRes.statusMessage || "Unknown error";
    // Likely Bad Gateway or Gateway Timeout from reverse proxy/load balancer
    logger.warn(
      { statusCode, statusMessage, key: req.key?.hash },
      parseError.message
    );

    const errorObject = {
      statusCode,
      statusMessage: proxyRes.statusMessage,
      error: parseError.message,
      proxy_note: `This is likely a temporary error with the upstream service.`,
    };
    writeErrorResponse(req, res, statusCode, errorObject);
    throw new Error(parseError.message);
  }

  logger.warn(
    {
      statusCode,
      type: errorPayload.error?.code,
      errorPayload,
      key: req.key?.hash,
    },
    `Received error response from upstream. (${proxyRes.statusMessage})`
  );


  if (req.outboundApi === "google") {
    try {
      if (body.toString().includes("key expired") || body.toString().includes("Key not found.") || body.toString().includes("Key not valid.")) {
        keyPool.deleteKeyByHash(req.key?.hash!);
        errorPayload.proxy_note = 'Google Key got revoked retry...'
        reenqueueRequest(req);
        throw new RetryableError("Google key got revoked, request re-enqueued.");
      }
    } catch(err) {
    }
	}

  if (statusCode === 400) {
      // Bad request (likely prompt is too long)
      if (req.outboundApi === "openai") {
        errorPayload.proxy_note = `Upstream service rejected the request as invalid. Your prompt may be too long for ${req.body?.model}.`;
      } else if (req.outboundApi === "anthropic" || req.key?.isAws) {
      
      // Remove invalid aws key.
      if (errorPayload.message === "Operation not allowed" ) {
          keyPool.deleteKeyByHash(req.key?.hash!);
        errorPayload.proxy_note = 'AWS Key got revoked retry...'
      } else {
          maybeHandleMissingPreambleError(req, errorPayload);
        }
    }
  } else if (statusCode === 403) {
	if (req.outboundApi === "anthropic") {
		if (errorPayload.message === "The security token included in the request is invalid.") {
		  keyPool.deleteKeyByHash(req.key?.hash!);
		  errorPayload.proxy_note = 'AWS Key got revoked retry...'
		}
	}
  } else if (statusCode === 401 || statusCode === 402) {
    // Key is invalid or was revoked
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `API key is invalid or revoked. Retry the request. ${tryAgainMessage}`;
	reenqueueRequest(req); //retry
    throw new RetryableError("Rate-limited request re-enqueued.");
  } else if (statusCode === 429) {
    // OpenAI uses this for a bunch of different rate-limiting scenarios.
    if (req.outboundApi === "openai") {
      handleOpenAIRateLimitError(req, tryAgainMessage, errorPayload);
    } else if (req.outboundApi === "anthropic") {
      handleAnthropicRateLimitError(req, errorPayload);
    } else if (req.outboundApi === "google" || req.inboundApi === "google") {
	  handleGoogleRateLimitError(req, errorPayload);
	} else if (req.outboundApi === "grok") {
	  if (errorPayload.error.includes("reached its monthly spending limit")) {
			keyPool.disable(req.key!, "revoked");
			errorPayload.proxy_note = `API key is invalid or revoked. Retry the request. ${tryAgainMessage}`;
			reenqueueRequest(req); //retry
			throw new RetryableError("Rate-limited request re-enqueued.");
		}
	}
	
  } else if (statusCode === 404) {
    // Most likely model not found
    if (req.outboundApi === "openai") {
      // TODO: this probably doesn't handle GPT-4-32k variants properly if the
      // proxy has keys for both the 8k and 32k context models at the same time.
      if (errorPayload.error?.code === "model_not_found") {
        if (req.key!.isGpt4) {
          errorPayload.proxy_note = `Assigned key isn't provisioned for the GPT-4 snapshot you requested. Try again to get a different key, or use Turbo.`;
        } else {
          errorPayload.proxy_note = `No model was found for this key.`;
        }
      }
    } else if (req.outboundApi === "anthropic") {
      errorPayload.proxy_note = `The requested Claude model might not exist, or the key might not be provisioned for it.`;
    }
  } else {
    errorPayload.proxy_note = `Unrecognized error from upstream service.`;
  }

  // Some OAI errors contain the organization ID, which we don't want to reveal.
  if (errorPayload.error?.message) {
    errorPayload.error.message = errorPayload.error.message.replace(
      /org-.{24}/gm,
      "org-xxxxxxxxxxxxxxxxxxx"
    );
  }
 
  writeErrorResponse(req, res, statusCode, errorPayload);
  throw new Error(errorPayload.error?.message);
};

/**
 * This is a workaround for a very strange issue where certain API keys seem to
 * enforce more strict input validation than others -- specifically, they will
 * require a `\n\nHuman:` prefix on the prompt, perhaps to prevent the key from
 * being used as a generic text completion service and to enforce the use of
 * the chat RLHF.  This is not documented anywhere, and it's not clear why some
 * keys enforce this and others don't.
 * This middleware checks for that specific error and marks the key as being
 * one that requires the prefix, and then re-enqueues the request.
 * The exact error is:
 * ```
 * {
 *   "error": {
 *     "type": "invalid_request_error",
 *     "message": "prompt must start with \"\n\nHuman:\" turn"
 *   }
 * }
 * ```
 */
function maybeHandleMissingPreambleError(
  req: Request,
  errorPayload: Record<string, any>
) {
  // keyPool.disable(req.key!, "revoked");
  if (
    errorPayload.error?.type === "invalid_request_error" &&
    errorPayload.error?.message === 'prompt must start with "\n\nHuman:" turn'
  ) {
    req.log.warn(
      { key: req.key?.hash },
      "Request failed due to missing preamble. Key will be marked as such for subsequent requests."
    );
    keyPool.update(req.key!, { requiresPreamble: true });
    reenqueueRequest(req);
    throw new RetryableError("Claude request re-enqueued to add preamble.");
  } else {
    errorPayload.proxy_note = `Proxy received unrecognized error from Anthropic. Check the specific error for more information.`;
  }
}

function handleAnthropicRateLimitError(
  req: Request,
  errorPayload: Record<string, any>
) {


  if (errorPayload.error?.type === "rate_limit_error" || errorPayload.message.includes("Too many requests") || errorPayload.message.includes("Too many tokens") ) {
    keyPool.markRateLimited(req.key!);
    reenqueueRequest(req);
    throw new RetryableError("Rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized rate limit error from Anthropic. Key may be over quota.`;
  }
}

function handleGoogleRateLimitError(
  req: Request,
  errorPayload: Record<string, any>
) {


  if (errorPayload.error?.status === "RESOURCE_EXHAUSTED") {
	if (req.body.model.includes("gemini-exp")) {
		keyPool.update(req.key!, { hasQuotaExp: false });
		errorPayload.proxy_note = `Assigned Gemini Experimental key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } else if (req.body.model.includes("1.5") && !req.body.model.includes("flash")) {
		keyPool.update(req.key!, { hasQuota15: false });
		errorPayload.proxy_note = `Assigned Gemini 1.5 key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } else if (req.body.model.includes("1.0")) {
		keyPool.update(req.key!, { hasQuota10: false });
		errorPayload.proxy_note = `Assigned Gemini 1.0 key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } else if (req.body.model.includes("1.5-flash")) {
		keyPool.update(req.key!, { hasQuotaFlash: false });
		errorPayload.proxy_note = `Assigned Gemini 1.5 Flash key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } else if (req.body.model.includes("2.0-flash-thinking")) {
		keyPool.update(req.key!, { hasQuotaThinking: false });
		errorPayload.proxy_note = `Assigned Gemini 2.0 Thinking key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } else if (req.body.model.includes("2.0-flash")) {
		keyPool.update(req.key!, { hasQuota20Flash: false });
		errorPayload.proxy_note = `Assigned Gemini 2.0 Flash key's quota has been exceeded, just don't panic and try again or lower your context size.`;
    } 
	


  } else {
    // keyPool.markRateLimited(req.key!);
    // reenqueueRequest(req);
    // throw new RetryableError("Rate-limited request re-enqueued.");
	// // maybe should reque? but no idea for now no, never got standard 429 on google api myself.
  }
}

function handleOpenAIRateLimitError(
  req: Request,
  tryAgainMessage: string,
  errorPayload: Record<string, any>
): Record<string, any> {
  const type = errorPayload.error?.type;

  if (type === "insufficient_quota") {
    // Billing quota exceeded (key is dead, disable it)
    keyPool.disable(req.key!, "quota");
    errorPayload.proxy_note = `Assigned key's quota has been exceeded. ${tryAgainMessage}`;
  } else if (type === "access_terminated") {
    // Account banned (key is dead, disable it)
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned key has been banned by OpenAI for policy violations. ${tryAgainMessage}`;
  } else if (type === "billing_not_active") {
    // Billing is not active (key is dead, disable it)
    keyPool.disable(req.key!, "revoked");
    errorPayload.proxy_note = `Assigned key was deactivated by OpenAI. ${tryAgainMessage}`;
  } else if (type === "requests" || type === "tokens" || type === undefined) {
    // Per-minute request or token rate limit is exceeded, which we can retry
    keyPool.markRateLimited(req.key!);
    // I'm aware this is confusing -- throwing this class of error will cause
    // the proxy response handler to return without terminating the request,
    // so that it can be placed back in the queue.
    reenqueueRequest(req);
    throw new RetryableError("Rate-limited request re-enqueued.");
  } else {
    // OpenAI probably overloaded
    errorPayload.proxy_note = `This is likely a temporary error with OpenAI. Try again in a few seconds.`;
  }
  return errorPayload;
}

const incrementKeyUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (isCompletionRequest(req) || req.outboundApi == "anthropic") {
    keyPool.incrementPrompt(req.key!);
    if (req.user) {
      incrementPromptCount(req.user.token, req.body.model, req.ip.toString(), req.outboundApi);
    }
  }
};

const trackRateLimit: ProxyResHandlerWithBody = async (proxyRes, req) => {
  keyPool.updateRateLimits(req.key!, proxyRes.headers);
};

const copyHttpHeaders: ProxyResHandlerWithBody = async (
  proxyRes,
  _req,
  res
) => {
  Object.keys(proxyRes.headers).forEach((key) => {
    // Omit content-encoding because we will always decode the response body
    if (key === "content-encoding") {
      return;
    }
    // We're usually using res.json() to send the response, which causes express
    // to set content-length. That's not valid for chunked responses and some
    // clients will reject it so we need to omit it.
    if (key === "transfer-encoding") {
      return;
    }
	
	res.setHeader(key, proxyRes.headers[key] as string);
  });
};
