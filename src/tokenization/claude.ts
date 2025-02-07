import { Tiktoken } from "tiktoken/lite";
import claude from "./claude_tokenizer.json";

let encoder: Tiktoken;

export function init() {
  encoder = new Tiktoken(
    claude.bpe_ranks,
    claude.special_tokens,
    claude.pat_str
  );
  return true;
}


export function getTokenCount(prompt: string | object) {
  let numTokens = 0;

  if (typeof prompt === "string") {
    if (prompt.length > 1000000) {
      numTokens = 200000;
      return {
        tokenizer: "tiktoken (prompt length limit exceeded)",
        token_count: numTokens,
      };
    }
    numTokens += encoder.encode(prompt.normalize('NFKC'), 'all').length;
  } else if (typeof prompt === "object") {
    const extractedText = extractTextFromJson(prompt);
    numTokens += encoder.encode(extractedText.normalize('NFKC'), 'all').length;
  } else {
    return { tokenizer: "tiktoken", token_count: 0 };
  }

  return { tokenizer: "tiktoken", token_count: numTokens };
}

function extractTextFromJson(json: object): string {
  const messages = Array.isArray(json) ? json : [json];
  let extractedText = '';

  for (const message of messages) {
    if (typeof message === 'object' && 'content' in message) {
      const content = message['content'];

      if (typeof content === 'string') {
        extractedText += content;

      } else if (Array.isArray(content)) {

        for (const block of content) {
          if(block['type'] === 'text') {
            extractedText += block['content'];
          }
          // ignoring images
        }
      }
    }
  }

  return extractedText;
}