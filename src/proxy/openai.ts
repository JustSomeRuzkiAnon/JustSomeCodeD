import { RequestHandler, Request, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { keyPool } from "../key-management";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError, writeErrorResponse } from "./middleware/common";
import { RequestPreprocessor } from "./middleware/request";
import { HttpRequest } from "@smithy/protocol-http";

import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
  limitCompletions,
  removeOriginHeaders,
} from "./middleware/request";
import {
  createOnProxyResHandler,
  ProxyResHandlerWithBody,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;


export const gptVariants = [
	"tts-1",
	"tts-1-hd",

	"dall-e-2",
	"dall-e-3",

	"o1-mini",
	"o1-mini-2024-09-12",
	"o1",
	"o1-preview",
	"o1-preview-2024-09-12",
    "o1-2024-12-17",
	"o3-mini",
	"o3-mini-2025-01-31",
	

  "gpt-4.5-preview-2025-02-27",
  "gpt-4.5-preview",

	"gpt-4o-mini",
	"gpt-4o-mini-2024-07-18",
	"gpt-4o",
	"gpt-4o-2024-05-13",
	"gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
	"gpt-4",
	"gpt-4-0613",
	"gpt-4-0314",
	"gpt-4-32k",
	"gpt-4-32k-0613",
	"gpt-4-32k-0314",
	"gpt-4-1106-preview",
	"gpt-4-0125-preview",
	"gpt-4-turbo",
	"gpt-4-turbo-2024-04-09",
	"gpt-4-turbo-preview",
	"gpt-4-vision-preview",
	"gpt-4-1106-vision-preview",
	"gpt-3.5-turbo-1106", 
	"gpt-3.5-turbo",
	"gpt-3.5-turbo-0301",
	"gpt-3.5-turbo-0613",
	"gpt-3.5-turbo-16k",
	"gpt-3.5-turbo-16k-0613",
	"gpt-3.5-turbo-instruct",
	"gpt-3.5-turbo-instruct-0914",


	// Moderated / Semi moderated
	"o1-mini-moderated",
	"o1-mini-2024-09-12-moderated",
	"o3-mini-moderated",
    "o1-preview-moderated",
	"o1-preview-2024-09-12-moderated",
	"o1-moderated",
	"gpt-4o-mini-moderated",
	"gpt-4o-mini-2024-07-18-moderated",
	"gpt-4o-moderated",
	"gpt-4o-2024-05-13-moderated",
	"gpt-4o-2024-08-06-moderated",
	"gpt-4o-2024-11-20-moderated",
	"gpt-4-moderated",
	"gpt-4-0613-moderated",
	"gpt-4-0314-moderated",
	"gpt-4-32k-moderated",
	"gpt-4-32k-0613-moderated",
	"gpt-4-32k-0314-moderated",
	"gpt-4-1106-preview-moderated",
	"gpt-4-0125-preview-moderated",
	"gpt-4-turbo-moderated",
	"gpt-4-turbo-2024-04-09-moderated",
	"gpt-4-turbo-preview-moderated",
	"gpt-4-vision-preview-moderated",
	"gpt-4-1106-vision-preview-moderated",
	"gpt-3.5-turbo-1106-moderated", 
	"gpt-3.5-turbo-moderated",
	"gpt-3.5-turbo-0301-moderated",
	"gpt-3.5-turbo-0613-moderated",
	"gpt-3.5-turbo-16k-moderated",
	"gpt-3.5-turbo-16k-0613-moderated",


	// Embedings support:
	"text-embedding-ada-002",
	"text-embedding-3-small",
	"text-embedding-3-large",

	// Chatgpt models ig ;v 
	"chatgpt-4o-latest"
];


function getModelsResponse() {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  const gpt4Available = keyPool.list().filter((key) => {
    return key.service === "openai" && !key.isDisabled && key.isGpt4;
  }).length;

  const models = gptVariants
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "openai",
      permission: [
        {
          id: "modelperm-" + id,
          object: "model_permission",
          created: new Date().getTime(),
          organization: "*",
          group: null,
          is_blocking: false,
        },
      ],
      root: id,
      parent: null,
    }))
    .filter((model) => {
      if (model.id.startsWith("gpt-4")) {
        return gpt4Available > 0;
      }
      return true;
    });

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
}

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};


function transformTurboInstructResponse(
  turboInstructBody: Record<string, any>
): Record<string, any> {
  const transformed = { ...turboInstructBody };
  transformed.choices = [
    {
      ...turboInstructBody.choices[0],
      message: {
        role: "assistant",
        content: turboInstructBody.choices[0].text.trim(),
      },
    },
  ];
  delete transformed.choices[0].text;
  return transformed;
}


const rewriteForTurboInstruct: RequestPreprocessor = (req) => {
  if (req.body.prompt && !req.body.messages) {
    //req.inboundApi = "openai-text";
  } else if (req.body.messages && !req.body.prompt) {
    req.inboundApi = "openai";
    // Set model for user since they're using a client which is not aware of
    // turbo-instruct.
    req.body.model = "gpt-3.5-turbo-instruct";
  } else {
    throw new Error("`prompt` OR `messages` must be provided");
  }

  req.url = "/v1/completions";
};


const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    limitCompletions,
    removeOriginHeaders,
    finalizeBody,
  ];
  

  try {
    for (const rewriter of rewriterPipeline) {
	  rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    req.log.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  proxyRes,
  req,
  res,
  body
) => {

  // Audio binary data (not working)
  if (req.body.model.startsWith("tts-")) {
    // Handle the binary data
    const responseFormat = req.body.response_format || "mp3";
    res.setHeader("Content-Type", `audio/${responseFormat}`);

    // Check if body is a Buffer
    if (Buffer.isBuffer(body)) {
      res.status(200).send(body);
    } else {
      // Handle unexpected cases
      throw new Error("Expected body to be a Buffer for audio responses.");
    }
  } else {
    // Handle JSON responses
    if (typeof body === "object" && body !== null && !Buffer.isBuffer(body)) {
      // Process the JSON object
      res.status(proxyRes.statusCode ?? 200).json(body);
    } else {
      // Handle unexpected cases
      throw new Error("Expected body to be a JSON object for non-audio responses.");
    }
  }
};

const SPECIAL_HOST =
  process.env.SPECIAL_HOST || "%endpoint%";



interface Message {
    role: string;
    content: string;
}

export const specialCheck: RequestPreprocessor = async (req, res) => {
	try {
		req.key = keyPool.get(req.body.model, false);
	} catch (err) {
	  writeErrorResponse(req, res, 500, {
        error: {
          type: "proxy_internal_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
        },
      });
	}
	
	const strippedParams = req.body
	try{
	if (req.key?.key.includes(";")) {
		if (req.key?.specialMap) {
			const deployment = req.key.specialMap[req.body.model] ;
			const host = req.key.key.split(";")[0]
			const api_key = req.key.key.split(";")[1]
			const newRequest = new HttpRequest({
			method: "POST",
			protocol: "https:",
			hostname: host.replace("https://",""),
			path: `/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`,
			headers: {
			  ["Host"]: host,
			  ["Content-Type"]: "application/json",
			  ["api-key"]: api_key || "",
			},
			body: JSON.stringify(strippedParams),
		  });
		  req.newRequest = newRequest
	  }
	  
	} else {
		if (strippedParams.model.includes("text-embedding-")) {
			const newRequest = new HttpRequest({
			  method: "POST",
			  protocol: "https:",
			  hostname: "api.openai.com",
			  path: `/v1/embeddings `,
			});
			req.newRequest = newRequest
		} else if (strippedParams.model.voice != undefined) { 
			const newRequest = new HttpRequest({
			  method: "POST",
			  protocol: "https:",
			  hostname: "api.openai.com",
			  path: `/v1/audio/speech `,
			});
			req.newRequest = newRequest
		} else if (strippedParams.model.includes("dall-")) {
		
			if (req.body.messages) {
				const messages = req.body.messages;
			
				const lastUserMessage = messages
				.filter((message: Message) => message.role === 'user')
				.pop(); // Get the last item from the filtered array
				delete req.body 
				req.body = {
					"stream": strippedParams.stream,
					"model": strippedParams.model,
					"prompt": lastUserMessage.content,
					"n": 1,
					"response_format":"b64_json",
					"size": "1024x1024"
					
					}
				
			}
			  
			const newRequest = new HttpRequest({
			  method: "POST",
			  protocol: "https:",
			  hostname: "api.openai.com",
			  path: `/v1/images/generations `,
			});
			req.newRequest = newRequest
		} else {			
			const newRequest = new HttpRequest({
			  method: "POST",
			  protocol: "https:",
			  hostname: "api.openai.com",
			  path: `/v1/chat/completions`,
			});
			req.newRequest = newRequest
		}
	  }
	} catch (error) {
	  throw new Error("OpenAI proxying error, key/endpoint issue, try again or report to Drago.");
	}
}


// https://api.openai.com
// 		proxyReq.setHeader('host', assignedKey.endpoint + '/openai/deployments/gpt-4/chat/completions?api-version=2023-03-15-preview');
const openaiProxy = createQueueMiddleware({
  beforeProxy: specialCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ newRequest }) => {
      if (!newRequest) throw new Error("Must create new request before proxying");
      return `${newRequest.protocol}//${newRequest.hostname}`;
    },
	logger,
    on: {
      proxyReq: rewriteRequest,
      proxyRes: createOnProxyResHandler([openaiResponseHandler]),
      error: handleProxyError,
    },
	changeOrigin: true,
	selfHandleResponse: true
  })
  
});

const openaiRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
openaiRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
openaiRouter.get("/v1/models", handleModelRequest);


openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);

openaiRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);

openaiRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);

openaiRouter.post(
  "/v1/audio/speech",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "openai" }),
  openaiProxy
);

openaiRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});
openaiRouter.use((req, res) => {
  req.log.warn(`Blocked openai proxy request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const openai = openaiRouter;
