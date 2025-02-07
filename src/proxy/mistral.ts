import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { keyPool } from "../key-management";
import { ipLimiter } from "./rate-limit";
import { handleProxyError, writeErrorResponse } from "./middleware/common";
import { RequestPreprocessor } from "./middleware/request";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";

import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
  removeOriginHeaders,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";

let modelsCache: any = null;
let modelsCacheTime = 0;

async function sign(request: HttpRequest, accessKeyId: string, secretAccessKey: string, region: string) {
  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });
  return signer.sign(request);
}



export const mistralVariants = [
// Excluded any deprecated production models.
// 32k 
"codestral-latest",
"codestral-2405",

"open-mistral-7b",
"open-mixtral-8x7b",

"mistral-small-latest",
"mistral-small-2501",

// 64k 
"open-mixtral-8x22b",

// 128k
"mistral-large-latest",
"mistral-large-2411",
"mistral-large-2407",
"mistral-large-2402",

"pixtral-large-latest",
"pixtral-large-2411",
"pixtral-12b-2409",

"open-mistral-nemo",
"open-mistral-nemo-2407",

"ministral-3b-latest",
"ministral-3b-2410",
// 256k
"open-codestral-mamba",

//AWS
"mistral.mistral-large-2407-v1:0",
"mistral.mistral-large-2402-v1:0",
]; 
  
  
const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.mistralKey) return { object: "list", data: [] };

  const models = mistralVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "mistralai",
	capabilities: {
		completion_chat: true,
		completion_fim: false,
		function_calling: false,
		fine_tuning: false,
		vision: true },
	name: id,
	description: "mistral ai model",
	max_context_length: 200000,
	default_model_temperature: 1.0,
    permission: [],
    root: "mistral",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};


const squashAWS = (
  req: Request,
  res: http.ServerResponse,
) => {
    if (req.key?.isAws && Array.isArray(req.body.messages)) {
        const newMessages: { role: string; content: string }[] = [];
        let tempMessage: { role: string; content: string } = { role: '', content: '' };

        // Specify message type
        req.body.messages.forEach((message: { role: string; content: string }) => {
            if (message.role === 'user' || message.role === 'assistant') {
                if (tempMessage.role === message.role) {
                    tempMessage.content += message.content;
                } else {
                    if (tempMessage.role) newMessages.push({ ...tempMessage });
                    tempMessage = { role: message.role, content: message.content };
                }
            } else {
                if (tempMessage.role) newMessages.push({ ...tempMessage });
                newMessages.push(message);
                tempMessage = { role: '', content: '' };
            }
        });

        if (tempMessage.role) newMessages.push({ ...tempMessage });

        // Update the request body with the squashed messages
        req.body.messages = newMessages;
    }
};



const rewriteMistralRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
	addKey,
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

/** Only used for non-streaming requests. */
const mistralResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
	
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

 

  res.status(200).json(body);
};



/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformMistralResponse(
  mistralBody: Record<string, any>
): Record<string, any> {
  const output = (mistralBody.candidates[0]?.content.parts[0]?.text || "Unknown fucking error occured report to fucking drago...")?.trim();
  return {
    id: "mist-" + mistralBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: mistralBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "text",
          content: output,
        },
        finish_reason: mistralBody.stop_reason,
        index: 0,
      },
    ],
  };
}


// Yeah aws support in future for now just this
export const mistralAwsCheck: RequestPreprocessor = async (req, res) => {
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

	if (req.key?.isAws) { 
		await squashAWS(req, res)
		let { model, stream, messages, temperature, top_p, max_tokens } = req.body;
		const strippedParams = {
			messages,
			temperature,
			top_p,
			max_tokens,
			stream
		  };
		
		let modelSelected = model
		
		if (modelSelected == "mistral-large-latest") {
			modelSelected = "mistral.mistral-large-2407-v1:0"
		} else if (modelSelected == "mistral-large-2402") {
			modelSelected = "mistral.mistral-large-2402-v1:0"
		} else {
			modelSelected = "mistral.mistral-large-2407-v1:0";
		}

		const key = req.key.key

		const awsSecret = req.key.awsSecret || ""
		const awsRegion = req.key.awsRegion || ""
		

		const host = req.key.endpoint || ""
		const newRequest = new HttpRequest({
		method: "POST",
		protocol: "https:",
		hostname: `bedrock-runtime.${awsRegion}.amazonaws.com`,
		path: `/model/${modelSelected}/invoke${stream ? "-with-response-stream" : ""}`,
		headers: {
		  ["Host"]: `bedrock-runtime.${awsRegion}.amazonaws.com`,
		  ["content-type"]: "application/json",  
			},
			body: JSON.stringify(strippedParams),
		});
		
		if (stream) {
			newRequest.headers["x-amzn-bedrock-accept"] = "application/json";
		} else {
			newRequest.headers["accept"] = "*/*";
		}
		
		req.signedRequest = await sign(newRequest, key, awsSecret, awsRegion);
	
	} else {
	
		const strippedParams = req.body
	
		const newRequest = new HttpRequest({
		method: "POST",
		protocol: "https:",
		hostname: "api.mistral.ai", 
		port: 80,
		path: `/v1/chat/completions`,
		headers: {
		  ["host"]: "api.mistral.ai",
		  ["content-type"]: "application/json",
		},
		body: JSON.stringify(strippedParams),
	  })
	  if (strippedParams.stream) {
		newRequest.headers["accept"] = "application/json";
	  }
	  req.signedRequest = newRequest
	  
  }
}

const mistralProxy = createQueueMiddleware({
  beforeProxy: mistralAwsCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must create new request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    on: {
      proxyReq: rewriteMistralRequest,
      proxyRes: createOnProxyResHandler([mistralResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '': ''
	  }
  })
});




const mistralRouter = Router();


// Fix paths because clients don't consistently use the /v1 prefix.
mistralRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});


mistralRouter.get("/v1/models", handleModelRequest);

mistralRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "mistral", outApi: "mistral" }),
  mistralProxy
);


// Redirect browser requests to the homepage.
mistralRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const mistral = mistralRouter;
