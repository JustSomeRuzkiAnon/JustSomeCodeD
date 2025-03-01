import { Request } from "express";
import { z } from "zod";
import { config } from "../../../config";
import { countTokens } from "../../../tokenization";
import { RequestPreprocessor } from ".";

const CLAUDE_MAX_CONTEXT = config.maxContextTokensAnthropic;
const OPENAI_MAX_CONTEXT = config.maxContextTokensOpenAI;
const GOOGLE_MAX_CONTEXT = config.maxContextTokensGoogle;
const MISTRAL_MAX_CONTEXT = config.maxContextTokensMistral;

const CLAUDE_MAX_OUTPUT = config.maxOutputTokensAnthropic;
const OPENAI_MAX_OUTPUT = config.maxOutputTokensOpenAI;
const GOOGLE_MAX_OUTPUT = config.maxOutputTokensGoogle;
const MISTRAL_MAX_OUTPUT = config.maxOutputTokensMistral;



/**
 * Assigns `req.promptTokens` and `req.outputTokens` based on the request body
 * and outbound API format, which combined determine the size of the context.
 * If the context is too large, an error is thrown.
 * This preprocessor should run after any preprocessor that transforms the
 * request body.
 */
export const checkContextSize: RequestPreprocessor = async (req) => {
  let prompt;
  
  if (req.body.model.includes("text-embedding-") || req.body.model.includes("dall-") || req.body.model.includes("tts-")) {
	return 
  }

  switch (req.outboundApi) {
    case "openai":
	  if (req.body.max_completion_tokens) {
		req.outputTokens = req.body.max_completion_tokens;
	  } else {
		req.outputTokens = req.body.max_tokens  || OPENAI_MAX_OUTPUT;
	  }
	  
      prompt = req.body.messages;
      break;
	case "mistral":
      req.outputTokens = req.body.max_tokens || MISTRAL_MAX_OUTPUT;
      prompt = req.body.messages;
      break;
	case "grok":
      req.outputTokens = req.body.max_tokens;
      prompt = req.body.messages;
      break;
	case "deepseek":
      req.outputTokens = req.body.max_tokens;
      prompt = req.body.messages;
      break;
	case "together":
      req.outputTokens = req.body.max_tokens;
      prompt = req.body.messages;
      break;
	case "cohere":
      req.outputTokens = req.body.max_tokens;
      prompt = req.body.messages;
      break;
    case "anthropic":
	  if (req.inboundApi == "openai") {
		req.outputTokens = req.body.max_tokens_to_sample;
		  prompt = req.body.messages;
	  } else {
		  if (req.body.max_tokens) {
			  req.outputTokens = req.body.max_tokens;
			  prompt = req.body.messages;

		  } else {
			  req.outputTokens = req.body.max_tokens_to_sample;
			  prompt = req.body.prompt;
		  }
      }
	  break;  
	case "google":
	  req.outputTokens = req.body.generationConfig.maxOutputTokens || GOOGLE_MAX_OUTPUT; // ._. 
      prompt = req.body.prompt;
      break;  
	case "ai21":
	  req.outputTokens = 1; // ._. ?
      prompt = req.body.prompt;
      break;
	  
    default:
      throw new Error(`Unknown outbound API: ${req.outboundApi}`);
  }

  const result = await countTokens({ req, prompt, service: req.outboundApi });
  req.promptTokens = result.token_count;

  // TODO: Remove once token counting is stable
  req.log.debug({ result: result }, "Counted prompt tokens.");
  req.debug = req.debug ?? {};
  req.debug = { ...req.debug, ...result };

  maybeReassignModel(req);
  validateContextSize(req);
};


function validateContextSize(req: Request) {
  assertRequestHasTokenCounts(req);
  const promptTokens = req.promptTokens;
  const outputTokens = req.outputTokens;
  const contextTokens = promptTokens + outputTokens;
  const model = req.body.model;

  const proxyMax =
    (req.outboundApi === "openai" ? OPENAI_MAX_CONTEXT :
	req.outboundApi === "cohere" ? OPENAI_MAX_CONTEXT :
	req.outboundApi === "deepseek" ? OPENAI_MAX_CONTEXT :
	req.outboundApi === "together" ? OPENAI_MAX_CONTEXT :
    req.outboundApi === "anthropic" ? CLAUDE_MAX_CONTEXT :
    req.outboundApi === "google" ? GOOGLE_MAX_CONTEXT :
    req.outboundApi === "mistral" ? MISTRAL_MAX_CONTEXT :
    Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
	
  let maxOutput = 0;
  let modelMax = 0;
  
  if (req.outboundApi === "openai" || req.outboundApi === "grok" || req.outboundApi === "deepseek" || req.outboundApi === "cohere" || req.outboundApi == "together") {
	maxOutput = OPENAI_MAX_OUTPUT
  } else if (req.outboundApi === "anthropic") {
    maxOutput = CLAUDE_MAX_OUTPUT
  } else if (req.outboundApi === "google") {
	maxOutput = GOOGLE_MAX_OUTPUT
  } else if (req.outboundApi === "mistral") {
	maxOutput = MISTRAL_MAX_OUTPUT
  }
  

  if (model.match(/gpt-3.5-turbo-16k/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-3.5-turbo-1106/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-3.5-turbo/)) {
    modelMax = 16384;
  } else if (model.match(/gpt-4-vision-preview/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-1106/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-0125-preview/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-turbo/) || model.match(/gpt-4o/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4-32k/)) {
    modelMax = 32768;
  } else if (model.match(/o1-/)) { // i think same as 4o?
    modelMax = 131072;
  }else if (model.match(/gpt-4\.5/)) {
    modelMax = 131072;
  } else if (model.match(/gpt-4/)) {
    modelMax = 8192;
  } else if (model.match(/claude-(?:instant-)?v1(?:\.\d)?(?:-100k)/)) {
    modelMax = 100000;
  } else if (model.match(/claude-(?:instant-)?v1(?:\.\d)?$/)) {
    modelMax = 9000;
  } else if (model.match(/claude-2/)) {
    modelMax = 200000;
  } else if (model.match(/claude-3/)) {
      modelMax = 200000;
  } else if (model.match(/text-bison-001-32k/)) {
    modelMax = 32768; 
  } else if (model.match(/gemini-1.0-pro/)) {
    modelMax = 32768; 
  } else if (model.match(/gemini-exp/) || model.match(/learnlm-/)) {
    modelMax = 32768; 
  } else if (model.match(/gemini-1.5-pro/)) {
    modelMax = 2097152; 
  } else if (model.match(/gemini-1.5-flash/) || model.match(/gemini-2.0/)) {
    modelMax = 1048576; 
  } else if (model.match(/gemini-ultra/) || model.match(/gemini-1.0-ultra/)) {
    modelMax = 30720; 
  } else if (model.match(/chat-bison-001/)) {
	modelMax = 4096; 
  } else if (model.match(/codestral-/)) {
    modelMax = 32768;  
  } else if (model.match(/mistral-large/) || model.match("pixtral-")) {
    modelMax = 131072;  
  } else if (model.match(/open-mistral-nemo/)) {
    modelMax = 131072;  
  } else if (model.match(/open-mixtral-8x22b/)) {
    modelMax = 65536; 
  } else if (model.match(/open-codestral-/)) {
    modelMax = 262144; 
  } else if (model.match(/open-mistral-/)) {
    modelMax = 32768; 
  } else if (model.match(/open-mistral-7b/)) {
    modelMax = 32768; 
  } else if (model.match(/open-mixtral-8x7b/)) {
    modelMax = 32768; 
  } else if (model.match(/open-mixtral-8x7b/)) {
    modelMax = 32768; 
  } else if (model.match(/grok-2-vision/) || model.match(/grok-vision/)) {
    modelMax = 8192; 
  } else if (model.match(/grok-2/) || model.match(/grok-beta/)) {
    modelMax = 131072; 
  } else if (model.match(/deepseek/)) {
    modelMax = 131072; 
  } else if (model.match(/command-r/)) {
    modelMax = 131072; 
  } else {

    req.log.warn({ model }, "Unknown model, using 2 Milion token limit.");
    modelMax = 2097152;
  }
  
  if (outputTokens > maxOutput) {
    throw new Error(`Output tokens exceed the maximum allowed for this proxy. (max: ${maxOutput}, requested: ${outputTokens})`);
  }

  if (typeof config.disabledModels === 'string' && config.disabledModels.includes(model)) {
    throw new Error(`${model} is disabled on proxy.`);
  }

  const finalMax = Math.min(proxyMax, modelMax);
  
  z.number()
    .int()
    .max(finalMax, {
      message: `Your request exceeds the context size limit for this model or proxy. (max: ${finalMax} tokens, requested: ${promptTokens} prompt + ${outputTokens} output = ${contextTokens} context tokens)`,
    })
    .parse(contextTokens);

  req.log.debug(
    { promptTokens, outputTokens, contextTokens, modelMax, proxyMax },
    "Prompt size validated"
  );

  req.debug.prompt_tokens = promptTokens;
  req.debug.max_model_tokens = modelMax;
  req.debug.max_proxy_tokens = proxyMax;
}

function assertRequestHasTokenCounts(
  req: Request
): asserts req is Request & { promptTokens: number; outputTokens: number } {
  z.object({
    promptTokens: z.number().int().min(1),
    outputTokens: z.number().int().min(1),
  })
    .nonstrict()
    .parse(req);
}

/**
 * For OpenAI-to-Anthropic requests, users can't specify the model, so we need
 * to pick one based on the final context size. Ideally this would happen in
 * the `transformOutboundPayload` preprocessor, but we don't have the context
 * size at that point (and need a transformed body to calculate it).
 */
function maybeReassignModel(req: Request) {
  
  return 
  // just no?

}
