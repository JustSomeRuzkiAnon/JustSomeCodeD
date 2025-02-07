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

export const cohereVariants = [
    "command-r7b-12-2024",
	"command-r-plus-08-2024",
	"command-r-plus-04-2024",
	"command-r-plus",
	"command-r-08-2024",
	"command-r-03-2024",
	"command-r",
	"command",
	"command-nightly",
	"command-light",
	"command-light-nightly",
	"c4ai-aya-expanse-8b",
	"c4ai-aya-expanse-32b"
  ]; 

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.cohereKey) return { object: "list", data: [] };

  const models = cohereVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "cohere",
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

const rewriteCohereRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {

  if (req.body.top_p !== undefined) {
	  req.body.p = req.body.top_p;
	  delete req.body.top_p;
	}
	
  delete req.body.logit_bias



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
const cohereResponseHandler: ProxyResHandlerWithBody = async (
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




const cohereProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.cohere.com/v2/chat",
    changeOrigin: true,
    on: {
      proxyReq: rewriteCohereRequest,
      proxyRes: createOnProxyResHandler([cohereResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/cohere/chat/completions': '', 
	  '^/v1/chat/completions': '', 
	  '^/proxy': ''
	  }
  })
});

const cohereRouter = Router();

// Fix paths because clients don't consistently use the /v1 prefix.
cohereRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
cohereRouter.get("/v1/models", handleModelRequest);
cohereRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "cohere", outApi: "cohere" }),
  cohereProxy
);

// OpenAI-to-Cohere compatibility endpoint.
cohereRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "cohere" }),
  (req, res, next) => {
    cohereProxy(req, res, next);
  }
);
// Redirect browser requests to the homepage.
cohereRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const cohere = cohereRouter;
