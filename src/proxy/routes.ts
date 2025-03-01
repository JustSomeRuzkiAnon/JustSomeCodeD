/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming OpenAI requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests must be transformed into
equivalent OpenAI requests. */

import * as express from "express";
import { gatekeeper } from "./auth/gatekeeper";
import { checkRisuToken } from "./auth/check-risu-token";
import { kobold } from "./kobold";
import { openai, gptVariants } from "./openai";
import { anthropic, claudeVariants } from "./anthropic";
import { google, googleVariants } from "./google";
import { ai21, ai21Variants } from "./ai21";
import { grok, grokVariants } from "./grok";
import { mistral, mistralVariants } from "./mistral";
import { deepseek, deepseekVariants } from "./deepseek";
import { cohere, cohereVariants } from "./cohere";
import { together, togetherVariants } from "./together";
import { config } from "../config"; 

const proxyRouter = express.Router();
const streamRouter = express.Router();

proxyRouter.use(
  express.json({ limit: "100mb" }),
  express.urlencoded({ extended: true, limit: "100mb" })
);
proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);

proxyRouter.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});

proxyRouter.use("/kobold", kobold);
proxyRouter.use("/openai", openai);
proxyRouter.use("/anthropic", anthropic);
proxyRouter.use("/google-ai", google);
proxyRouter.use("/ai21", ai21);
proxyRouter.use("/grok", grok);
proxyRouter.use("/deepseek", deepseek);
proxyRouter.use("/cohere", cohere);
proxyRouter.use("/mistral", mistral);
proxyRouter.use("/together", together);




// Need to move it all for now proof of concept for universal endpoint:




proxyRouter.get("(\/v1)?\/models", (req, res, next) => {
  const modelsResponse = getModelsResponse();
  res.json(modelsResponse);
});

proxyRouter.get("(\/stream)(\/v1)?\/models", (req, res, next) => {
  const modelsResponse = getModelsResponse();
  res.json(modelsResponse);
});


const modelVariantHandlers = {
  ...Object.fromEntries(mistralVariants.map(variant => [variant, mistral])),
  ...Object.fromEntries(grokVariants.map(variant => [variant, grok])),
  ...Object.fromEntries(ai21Variants.map(variant => [variant, ai21])),
  ...Object.fromEntries(claudeVariants.map(variant => [variant, anthropic])),
  ...Object.fromEntries(gptVariants.map(variant => [variant, openai])),
  ...Object.fromEntries(googleVariants.map(variant => [variant, google])),
  ...Object.fromEntries(deepseekVariants.map(variant => [variant, deepseek])),
  ...Object.fromEntries(cohereVariants.map(variant => [variant, cohere])),
  ...Object.fromEntries(togetherVariants.map(variant => [variant, together])),
};


// Required as 
proxyRouter.post(/^(\/v1|\/v1beta|\/v1alpha|\/beta)?\/((chat\/completions|complete|messages|embeddings|images\/generations|audio\/speech)|models\/([^\/]+)(\:generateContent|\:streamGenerateContent))?(\?key=([^"&\s]+))?$/, (req, res, next) => {
  const { model } = req.body;

  if (!model) {
	const urlParts = req.originalUrl.split('/');
	let pathModel = '';

	// Iterate through the parts to find 'models'
	for (let i = 0; i < urlParts.length; i++) {
		if (urlParts[i] === 'models') {
			// Ensure there's a next segment and split it by ':'
			if (i + 1 < urlParts.length) {
				pathModel = urlParts[i + 1].split(":")[0];
			}
			break; // Exit the loop once 'models' is found
		}
	}
	
	req.body.model = pathModel
	const handler = modelVariantHandlers[pathModel];
	
	

	if (handler) {
		handler(req, res, next);
	} else {
		// Handle invalid model variant
		res.status(400).json({ error: "Invalid model" });
	}	
  } else {  
	const handler = modelVariantHandlers[model];
	if (handler) {
		handler(req, res, next);
	} else {
		// Handle invalid model variant
		res.status(400).json({ error: "Invalid model" });
	}
  }
});


streamRouter.post(/^(\/v1|\/v1beta|\/v1alpha|\/beta)?\/((chat\/completions|complete|messages|embeddings|images\/generations|audio\/speech)|models\/([^\/]+)(\:generateContent|\:streamGenerateContent))?(\?key=([^"&\s]+))?$/, (req, res, next) => {
  req.body.stream = true;
  const { model } = req.body;
  
  if (!model) {
    const urlParts = req.originalUrl.split('/');
	let model = '';

	// Iterate through the parts to find 'models'
	for (let i = 0; i < urlParts.length; i++) {
		if (urlParts[i] === 'models') {
			// Ensure there's a next segment and split it by ':'
			if (i + 1 < urlParts.length) {
				model = urlParts[i + 1].split(":")[0];
			}
			break; // Exit the loop once 'models' is found
		}
	}
	
	
	
	const handler = modelVariantHandlers[model];
	if (handler) {
		handler(req, res, next);
	} else {
		// Handle invalid model variant
		res.status(400).json({ error: "Invalid model" });
	}	
  } else {  
	const handler = modelVariantHandlers[model];
	if (handler) {
		handler(req, res, next);
	} else {
		// Handle invalid model variant
		res.status(400).json({ error: "Invalid model" });
	}
  }
});


proxyRouter.use('/stream', streamRouter);
let modelsCache: any = null;
let modelsCacheTime = 0;

const allModels: string[] = [];
if (config.ai21Key) {
  allModels.push(...ai21Variants);
}
if (config.anthropicKey) {
  allModels.push(...claudeVariants);
}
if (config.openaiKey) {
  allModels.push(...gptVariants);
}
if (config.googleKey) {
  allModels.push(...googleVariants);
}

if (config.deepseekKey) {
  allModels.push(...deepseekVariants);
}

if (config.cohereKey) {
  allModels.push(...cohereVariants);
}

if (config.grokKey) {
  allModels.push(...grokVariants);
}

if (config.mistralKey) {
  allModels.push(...mistralVariants);
}

if (config.togetherKey) {
  allModels.push(...togetherVariants);
}  
  
const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  const models = allModels.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: id.includes('claude') ? 'anthropic' : id.includes('gpt') || id.includes('mistral') ? 'mistralai' : 'gemini' ||  id.includes('gemini') ? 'openai' : 'ai21' || id.includes('grok') ? 'openai' : 'grok' || id.includes('deepseek') ? 'openai' : 'deepseek' || id.includes('cohere') ? 'openai' : 'cohere' || id.includes('together') ? 'openai' : 'together',
	capabilities: {
		completion_chat: true,
	},
    permission: [],
    root: "openai",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};


export { proxyRouter as proxyRouter };
