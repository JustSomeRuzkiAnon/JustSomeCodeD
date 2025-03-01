import { Request } from "express";
import { config } from "../config";
import {
  init as initClaude,
  getTokenCount as getClaudeTokenCount,
} from "./claude";
import {
  init as initOpenAi,
  getTokenCount as getOpenAITokenCount,
  OpenAIPromptMessage,
} from "./openai";

import {
  init as initGoogleAi,
  getTokenCount as getGoogleTokenCount,
} from "./google";

import {
  init as initAi21Ai,
  getTokenCount as getAi21TokenCount,
} from "./ai21";

export async function init() {
  if (config.anthropicKey) {
    initClaude();
  }
  if (config.openaiKey || config.mistralKey || config.grokKey || config.deepseekKey || config.cohereKey) {
    initOpenAi();
  }
  
  
}

type TokenCountResult = {
  token_count: number;
  tokenizer: string;
  tokenization_duration_ms: number;
};
type TokenCountRequest = {
  req: Request;
} & (
  | { prompt: string; service: "anthropic" }
  | { prompt: string; service: "google" }
  | { prompt: string; service: "gemini" }
  | { prompt: string; service: "ai21" }
  | { prompt: OpenAIPromptMessage[]; service: "grok" }
  | { prompt: OpenAIPromptMessage[]; service: "deepseek" }
  | { prompt: OpenAIPromptMessage[]; service: "cohere" }
  | { prompt: OpenAIPromptMessage[]; service: "openai" }
  | { prompt: OpenAIPromptMessage[]; service: "mistral" }
  | { prompt: OpenAIPromptMessage[]; service: "together" }
  
);
export async function countTokens({
  req,
  service,
  prompt,
}: TokenCountRequest): Promise<TokenCountResult> {
  const time = process.hrtime();
  switch (service) {
    case "anthropic":
      return {
        ...getClaudeTokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "mistral":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "grok":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "deepseek":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "together":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "cohere":
      return {
        ...getOpenAITokenCount(prompt, req.body.model),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "google":
		return {
        ...getGoogleTokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };
	case "ai21":
		return {
        ...getAi21TokenCount(prompt),
        tokenization_duration_ms: getElapsedMs(time),
      };  
    default:
      throw new Error(`Unknown service: ${service}`);
  }
}

function getElapsedMs(time: [number, number]) {
  const diff = process.hrtime(time);
  return diff[0] * 1000 + diff[1] / 1e6;
}