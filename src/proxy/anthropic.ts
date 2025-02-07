import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError, writeErrorResponse } from "./middleware/common";
import { keyPool } from "../key-management";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { RequestPreprocessor } from "./middleware/request";
import { AnthropicV1CompleteSchema } from "./middleware/request/transform-outbound-payload";

import {
  addKey,
  addAnthropicPreamble,
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

export const claudeVariants = [
    "claude-v1",
    "claude-v1-100k",
    "claude-instant-v1",
    "claude-instant-v1-100k",
    "claude-v1.3",
    "claude-v1.3-100k",
    "claude-v1.2",
    "claude-v1.0",
    "claude-instant-v1.1",
    "claude-instant-v1.1-100k",
    "claude-instant-v1.0",
    "claude-2", 
    "claude-2.0",
    "claude-2.1",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
	"anthropic.claude-v1",
	"anthropic.claude-v2",
	"anthropic.claude-v2:1",
	"anthropic.claude-instant-v1",
	"anthropic.claude-3-sonnet-20240229-v1:0",
    "anthropic.claude-3-haiku-20240307-v1:0",
    "anthropic.claude-3-opus-20240229-v1:0",
    "claude-3-haiku-20240307",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
	"anthropic.claude-3-5-sonnet-20241022-v2:0",
    "claude-3-5-sonnet-20240620",
	"claude-3-5-sonnet-latest",
	"claude-3-5-sonnet-20241022",
	"claude-3-opus-latest",
  "claude-3-5-haiku-20241022",
  "anthropic.claude-3-5-haiku-20241022-v1:0"
  ];



const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [] };
  
  const models = claudeVariants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const rewriteAnthropicRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    addAnthropicPreamble,
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

const rewriteChatAnthropicRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey,
    addAnthropicPreamble,
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
const anthropicResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }
	

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Anthropic response to OpenAI format");
    body = transformAnthropicResponse(body);
  }

  res.status(200).json(body);
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAnthropicResponse(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.content[0].text?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}


async function sign(request: HttpRequest, accessKeyId: string, secretAccessKey: string, region: string) {
  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });
  return signer.sign(request);
}

export const awsCheck: RequestPreprocessor = async (req, res) => {
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
		
		let { model, stream } = req.body;
		req.isStreaming = stream === true || stream === "true";
		req.body.anthropic_version = "bedrock-2023-05-31"

		const strippedParams = AnthropicV1CompleteSchema.pick({
				messages: true,
				max_tokens: true,
				stop_sequences: true,
				temperature: true,
				top_k: true,
				top_p: true,
				anthropic_version: true, 
				system: true, 
		}).parse(req.body);

		let modelSelected = model



    // I should move it in future just to switch case :| but im lazy 
    if (!modelSelected.startsWith("anthropic.")) { // Request retrtied defaulted to 2.1 ._. ups
      if (modelSelected == "claude-3-opus-20240229") {
        modelSelected = "anthropic.claude-3-opus-20240229-v1:0"
      } else if (modelSelected == "claude-3-5-opus-latest") {
        modelSelected = "anthropic.claude-3-opus-20240229-v1:0"
      } else if (modelSelected == "claude-3-5-sonnet-latest") {
        modelSelected = "anthropic.claude-3-5-sonnet-20241022-v2:0"
      } else if (modelSelected == "claude-3-5-sonnet-20241022") {
        modelSelected = "anthropic.claude-3-5-sonnet-20241022-v2:0"
      } else if (modelSelected == "claude-3-5-sonnet-20240620") {
        modelSelected = "anthropic.claude-3-5-sonnet-20240620-v1:0"
      } else if (modelSelected == "claude-3-sonnet-20240229") {
        modelSelected = "anthropic.claude-3-sonnet-20240229-v1:0";
      } else if (modelSelected == "claude-3-haiku-20240307") {
        modelSelected = "anthropic.claude-3-haiku-20240307-v1:0";
      } else if (modelSelected == "claude-2.1" || modelSelected == "claude-2"){
        modelSelected = "anthropic.claude-v2:1";
      } else if (modelSelected == "claude-2.0"){
        modelSelected = "anthropic.claude-v2";
      } else if (modelSelected == "claude-v1.2" || modelSelected == "claude-v1" || modelSelected == "claude-v1.3" || modelSelected == "claude-v1.3-100k"  || modelSelected == "claude-v1-100k" || modelSelected == "claude-v1.0"){
        modelSelected = "anthropic.claude-v1";
      } else if (modelSelected.includes("instant")) {
        modelSelected = "anthropic.claude-instant-v1";
      } else {
        modelSelected = "anthropic.claude-v2:1";
      }
    }
		

		req.body.model = modelSelected
		
		const key = req.key.key 
		const awsSecret = req.key.awsSecret || ""
		const awsRegion = req.key.awsRegion || ""
		
		
		
		req.headers["anthropic-version"] = "2023-06-01";

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
		req.headers["anthropic-version"] = "2023-06-01";
		
		const newRequest = new HttpRequest({
		  method: "POST",
		  protocol: "https:",
		  hostname: "api.anthropic.com",
		  path: `/v1/ `,
		  body: req.body,
		}) 
		
		newRequest.headers["anthropic-version"] = "2023-06-01";
	
		req.signedRequest = newRequest
		
  }

}
	
	



const anthropicProxy = createQueueMiddleware({
  beforeProxy: awsCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must create new request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req, res, options) => {
        if (req.path === "/v1/messages") {
          rewriteChatAnthropicRequest(proxyReq, req, res);
        } else {
          rewriteAnthropicRequest(proxyReq, req, res);
        } },
      proxyRes: createOnProxyResHandler([anthropicResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
    pathRewrite: {
      // Send OpenAI-compat requests to the Anthropic 
	  "/chat/completions":"/messages",
      "^/v1/chat/completions": "/messages"
    },
  }),
});

const anthropicRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
anthropicRouter.use((req, _res, next) => {
  
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
anthropicRouter.get("/v1/models", handleModelRequest);
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "anthropic", outApi: "anthropic" }),
  anthropicProxy
);

anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "anthropic", outApi: "anthropic" }),
  anthropicProxy
);

anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "anthropic" }),
  anthropicProxy
);


// OpenAI-to-Anthropic compatibility endpoint.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "anthropic" }),
  anthropicProxy
);


// Redirect browser requests to the homepage.
anthropicRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const anthropic = anthropicRouter;
