import { Request, RequestHandler, Router } from "express";
import * as http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
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

export const grokVariants = [
    "grok-beta",
	"grok-vision-beta",
	"grok-2-1212",
	"grok-2-vision-1212",
  ]; 

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.grokKey) return { object: "list", data: [] };

  const models = grokVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "grok",
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
    // delete req.body.stream;
  }
};

const rewriteGroqRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {

  delete req.body.logprobs
  delete req.body.logit_bias
  delete req.body.top_logprobs
  

  const rewriterPipeline = [
    addKey,
    removeOriginHeaders,
    // removeStreamProperty,
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
const grokResponseHandler: ProxyResHandlerWithBody = async (
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




const grokProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.x.ai/v1/chat/completions",
    changeOrigin: true,
    on: {
      proxyReq: rewriteGroqRequest,
      proxyRes: createOnProxyResHandler([grokResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/grok/chat/completions': '', 
	  '^/v1/chat/completions': '', 
	  '^/proxy': ''
	  }
  })
});

const grokRouter = Router();

// Fix paths because clients don't consistently use the /v1 prefix.
grokRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
grokRouter.get("/v1/models", handleModelRequest);
grokRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "grok", outApi: "grok" }),
  grokProxy
);

// OpenAI-to-Groq compatibility endpoint. / Basically do nothing 
grokRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "grok" }),
  (req, res, next) => {
    grokProxy(req, res, next);
  }
);
// Redirect browser requests to the homepage.
grokRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const grok = grokRouter;
