import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { keyPool } from "../key-management";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import { RequestPreprocessor } from "./middleware/request";
import { HttpRequest } from "@smithy/protocol-http";
import {
  addKey,
  //addGooglePreamble,
  addImageFromPromptGemini,
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

export const googleVariants = [
  "chat-bison-001",
  "text-bison-001",
  "embedding-gecko-001",
  "gemini-pro",
  "gemini-pro-vision",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro-001",
  "gemini-1.5-pro-002",
  "gemini-1.5-pro",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-002",
  "gemini-1.5-flash",
  // "gemini-1.5-pro-exp-0801",
  // "gemini-1.5-pro-exp-0827",
  // "gemini-1.5-flash-exp-0827",
  //"gemini-1.5-flash-8b-exp-0827",
  //"gemini-1.5-flash-8b-exp-0924",
  "gemini-1.5-flash-8b-latest",
  // "gemini-exp-1114",
  // "gemini-exp-1121",
  // "gemini-exp-1206", removed not needed routes to 2.0 pro exp
  "learnlm-1.5-pro-experimental",
  "gemini-2.0-flash-lite-preview",
  "gemini-2.0-flash-lite-preview-02-05",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
  "gemini-2.0-flash-thinking-exp-01-21",
  // "gemini-2.0-flash-thinking-exp-1219",
  "gemini-2.0-flash-thinking-exp",
  "gemini-2.0-pro-exp",
  "gemini-2.0-pro-exp-02-05",
  "gemini-2.5-pro-exp-03-25"
  // Embeddings maybe in future 
  // "embedding-001",
  // "text-embedding-004",
  // "aqa",

]; 
  
  
const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.googleKey) return { object: "list", data: [] };

  const models = googleVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "google",
    permission: [],
    root: "openai",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};


const removeStreamProperty = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse,
  options: any
) => {
  if (req.body && typeof req.body === "object") {
    delete req.body.stream;
  }
};

const rewriteGoogleRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {
  const rewriterPipeline = [
    addKey, 
    removeOriginHeaders,
    removeStreamProperty,
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
const googleResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
	
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  if (req.inboundApi === "openai") {
    req.log.info("Transforming Google response to OpenAI format");
    body = transformGoogleResponse(body);
  }
 

  res.status(200).json(body);
};



/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformGoogleResponse(
  googleBody: Record<string, any>
): Record<string, any> {
  const output = (googleBody.candidates[0]?.content.parts[0]?.text || "Unknown fucking error occured report to fucking drago...")?.trim();
  return {
    id: "google-" + googleBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: googleBody.model,
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
        finish_reason: googleBody.stop_reason,
        index: 0,
      },
    ],
  };
}

export const geminiCheck: RequestPreprocessor = async (req) => {
	
	let currentProtocol = "https:"
	let currentHost = "generativelanguage.googleapis.com"
	if (!config.googleProxy.includes("googleapis")) {
		currentProtocol = "http:";
		currentHost = config.googleProxy;
		if (currentHost.includes(":")) {
			currentHost = config.googleProxy.split("://")[1];
		}
	}
	if (req.path.includes("streamGenerateContent")) {
		req.body.stream = true;
	};
	const strippedParams = req.body
	const version = req.body.model.includes("thinking") ? "v1alpha" : "v1beta"; // Check if model includes 
	
	const host = currentHost
	const newRequest = new HttpRequest({
	method: "POST",
	protocol: currentProtocol,
	hostname: host, 
	port: 80,
	path: `/${version}/models/${req.body.model}:${strippedParams.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
	headers: {
	  ["host"]: host,
	  ["content-type"]: "application/json",
	},
	body: JSON.stringify(strippedParams),
  })
  if (strippedParams.stream) {
	newRequest.headers["accept"] = "application/json";
  }
  req.newRequest = newRequest
}

const googleProxy = createQueueMiddleware({
  beforeProxy: geminiCheck,
  proxyMiddleware: createProxyMiddleware({
    target: "invalid-target-for-fun",
	  router: ({ newRequest }) => {
      if (!newRequest) throw new Error("Must create new request before proxying");
      return `${newRequest.protocol}//${newRequest.hostname}`;
    },
    changeOrigin: true,
    on: {
      proxyReq: rewriteGoogleRequest,
      proxyRes: createOnProxyResHandler([googleResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/google-ai/chat/completions': '', 
	  '^/proxy/google-ai/v1beta/models/(.*):generateContent': '',
	  '^/proxy/google-ai/v1beta/models/(.*):streamGenerateContent': '',
	  '^/proxy/google-ai/v1alpha/models/(.*):generateContent': '',
	  '^/proxy/google-ai/v1alpha/models/(.*):streamGenerateContent': '',
	  
	  }
  })
});




const googleRouter = Router();
// Fix paths because clients don't consistently use the /v1 prefix.
googleRouter.use((req, _res, next) => {
  // DONT REWRITE V1 betaaaaaaaaaaaaaaa
  
  if (req.baseUrl.startsWith("/v1beta/")) {
    req.url = req.baseUrl;
  }
  
  if (req.baseUrl.startsWith("/v1alpha/")) {
    req.url = req.baseUrl;
  }
  
  if (!req.path.startsWith("/v1/") && !req.path.startsWith("/v1beta/") && !req.path.startsWith("/v1alpha/")) {
    req.url = `/v1${req.url}`;
  }

  next();
});


googleRouter.get("/v1/models", handleModelRequest);
googleRouter.get("/v1beta/models", handleModelRequest);
googleRouter.get("/v1alpha/models", handleModelRequest);



googleRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "google", outApi: "google" }),
  googleProxy
);
// OpenAI-to-Google compatibility endpoint.
googleRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "google" }),
  (req, res, next) => {
    req.url = req.originalUrl; // Reset the URL to include the full path
    googleProxy(req, res, next);
  }
);


googleVariants.forEach(model => {
  googleRouter.post(
    `/v1beta/models/${model}:generateContent`,
    ipLimiter,
    createPreprocessorMiddleware({ inApi: "google", outApi: "google" }),
    (req, res, next) => {
      req.url = req.originalUrl; // Reset the URL to include the full path
      googleProxy(req, res, next);
    }
  );
});

googleVariants.forEach(model => {
  googleRouter.post(
    `/v1beta/models/${model}:streamGenerateContent`,
    (req, res, next) => {
      req.body.stream = true;
      next();
    },
    ipLimiter,
    createPreprocessorMiddleware({ inApi: "google", outApi: "google" }),
    (req, res, next) => {
      req.url = req.originalUrl; // Reset the URL to include the full path
      googleProxy(req, res, next);
    }
  );
});



googleVariants.forEach(model => {
  googleRouter.post(
    `/v1alpha/models/${model}:generateContent`,
    ipLimiter,
    createPreprocessorMiddleware({ inApi: "google", outApi: "google" }),
    (req, res, next) => {
      req.url = req.originalUrl; // Reset the URL to include the full path
      googleProxy(req, res, next);
    }
  );
});

googleVariants.forEach(model => {
  googleRouter.post(
    `/v1alpha/models/${model}:streamGenerateContent`,
    (req, res, next) => {
      req.body.stream = true;
      next();
    },
    ipLimiter,
    createPreprocessorMiddleware({ inApi: "google", outApi: "google" }),
    (req, res, next) => {
      req.url = req.originalUrl; // Reset the URL to include the full path
      googleProxy(req, res, next);
    }
  );
});




// Redirect browser requests to the homepage.
googleRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const google = googleRouter;
