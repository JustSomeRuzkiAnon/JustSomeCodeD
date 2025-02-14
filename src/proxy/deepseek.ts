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

export const deepseekVariants = [
    "deepseek-chat",
	"deepseek-coder",
	"deepseek-reasoner"
  ]; 

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.deepseekKey) return { object: "list", data: [] };

  const models = deepseekVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "deepseek",
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

const rewriteDeepseekRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {

  delete req.body.logprobs
  delete req.body.logit_bias
  delete req.body.top_logprobs
  
  if (req.body.model.includes("reasoner")) {

  if (Array.isArray(req.body.messages)) {
  
    // Gets all system messages (they need to be first, but doesn't merge them for no reason)
    const systemMessages = req.body.messages.filter((m: { role: string }) => m.role === 'system');
    let otherMessages = req.body.messages.filter((m: { role: string }) => m.role !== 'system');

    // Enforce user-first after system messages ( system > asistant is wrong needs to be system > user)
    if (otherMessages.length > 0 && otherMessages[0].role === 'assistant') {
        otherMessages = [
            { role: 'user', content: '' }, // Empty user message prepended
            ...otherMessages
        ];
    }

    // Merge same-role messages that are in a row(Mergingggggg...)
    const merged: Array<{ role: string; content: string }> = [];
    let currentRole: string | null = null;

    for (const msg of otherMessages) {
        if (msg.role === currentRole) {
            const last = merged[merged.length - 1];
            last.content += `\n${msg.content}`;
        } else {
            merged.push({
                role: msg.role,
                content: msg.content,
                ...(msg.prefix && { prefix: msg.prefix })
            });
            currentRole = msg.role;
        }
    }

    req.body.messages = [
        ...systemMessages,
        ...merged
    ];
   }

	
  // Auto prefix + reasoning content 
  if (Array.isArray(req.body.messages) && req.body.messages.length > 0) {
    const lastMessage = req.body.messages[req.body.messages.length - 1];
    if (lastMessage.role === "assistant") {
	  if (lastMessage.content.includes("</reasoning_content>")) {
		  const thoughtArray = lastMessage.content.split("</reasoning_content>")
		  if (thoughtArray[0].strip().startsWith("<thoreasoning_contentught>")) {
			lastMessage.reasoning_content = thoughtArray[0].slice(9)
		  } else {
			lastMessage.reasoning_content = thoughtArray[0]
		  }
		  lastMessage.content = thoughtArray[1]
	  }
      lastMessage.prefix = true;
    }
  }

  }


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
const deepseekResponseHandler: ProxyResHandlerWithBody = async (
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




const deepseekProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.deepseek.com/beta/chat/completions",
    changeOrigin: true,
    on: {
      proxyReq: rewriteDeepseekRequest,
      proxyRes: createOnProxyResHandler([deepseekResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/deepseek/chat/completions': '', 
	  '^/v1/chat/completions': '',
	  '^/beta/chat/completions': '', 
	  '^/proxy': ''
	  }
  })
});

const deepseekRouter = Router();

// Fix paths because clients don't consistently use the /v1 prefix.
deepseekRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
deepseekRouter.get("/v1/models", handleModelRequest);
deepseekRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "deepseek", outApi: "deepseek" }),
  deepseekProxy
);


deepseekRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "deepseek" }),
  (req, res, next) => {
    deepseekProxy(req, res, next);
  }
);

deepseekRouter.post(
  "/beta/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "deepseek" }),
  (req, res, next) => {
    deepseekProxy(req, res, next);
  }
);


// Redirect browser requests to the homepage.
deepseekRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const deepseek = deepseekRouter;