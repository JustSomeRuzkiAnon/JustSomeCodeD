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

export const togetherVariants = [
    "deepseek-ai/DeepSeek-R1",
	"deepseek-ai/DeepSeek-V3",
	"deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
	"deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
	"deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
	"meta-llama/Llama-3.3-70B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3-8B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3-70B-Instruct-Turbo",
	"meta-llama/Llama-3.2-3B-Instruct-Turbo",
	"meta-llama/Meta-Llama-3-8B-Instruct-Lite",
	"meta-llama/Meta-Llama-3-70B-Instruct-Lite",
	"meta-llama/Llama-3-8b-chat-hf",
	"meta-llama/Llama-3-70b-chat-hf",
	"nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
	"Qwen/Qwen2.5-Coder-32B-Instruct",
	"Qwen/QwQ-32B-Preview",
	"microsoft/WizardLM-2-8x22B",
	"google/gemma-2-27b-it",
	"google/gemma-2-9b-it",
	"databricks/dbrx-instruct",
	"google/gemma-2b-it",
	"Gryphe/MythoMax-L2-13b",
	"meta-llama/Llama-2-13b-chat-hf",
	"mistralai/Mistral-Small-24B-Instruct-2501",
	"mistralai/Mistral-7B-Instruct-v0.1",
	"mistralai/Mistral-7B-Instruct-v0.2",
	"mistralai/Mistral-7B-Instruct-v0.3",
	"mistralai/Mixtral-8x7B-Instruct-v0.1",
	"mistralai/Mixtral-8x22B-Instruct-v0.1",
	"NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO",
	"Qwen/Qwen2.5-7B-Instruct-Turbo",
	"Qwen/Qwen2.5-72B-Instruct-Turbo",
	"Qwen/Qwen2-72B-Instruct",
	"Qwen/Qwen2-VL-72B-Instruct",
	"upstage/SOLAR-10.7B-Instruct-v1.0"
  ]; 

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.togetherKey) return { object: "list", data: [] };

  const models = togetherVariants.map((id) => ({
    // MAY NEED CHANGE 
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "together",
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

const rewriteTogetherRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: http.ServerResponse
) => {



	if (req.body.model.includes("R1")) {

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
			  if (thoughtArray[0].strip().startsWith("<reasoning_content>")) {
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
const togetherResponseHandler: ProxyResHandlerWithBody = async (
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




const togetherProxy = createQueueMiddleware({
  proxyMiddleware: createProxyMiddleware({
    target: "https://api.together.xyz/v1/chat/completions",
    changeOrigin: true,
    on: {
      proxyReq: rewriteTogetherRequest,
      proxyRes: createOnProxyResHandler([togetherResponseHandler]),
      error: handleProxyError,
    },
    selfHandleResponse: true,
    logger,
	  pathRewrite: {
	  '^/proxy/together/chat/completions': '', 
    '^/together/chat/completions': '',
	  '^/v1/chat/completions': '',
	  '^/proxy/chat/completions': '', 
	  '^/proxy': '',
     '^/v1/proxy': ''
	  }
  })
});

const togetherRouter = Router();

// Fix paths because clients don't consistently use the /v1 prefix.
togetherRouter.use((req, _res, next) => {
  if (!req.path.startsWith("/v1/")) {
    req.url = `/v1${req.url}`;
  }
  next();
});
togetherRouter.get("/v1/models", handleModelRequest);
togetherRouter.post(
  "/v1/complete",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "together", outApi: "together" }),
  togetherProxy
);


togetherRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({ inApi: "openai", outApi: "together" }),
  (req, res, next) => {
    togetherProxy(req, res, next);
  }
);


// Redirect browser requests to the homepage.
togetherRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

export const together = togetherRouter;