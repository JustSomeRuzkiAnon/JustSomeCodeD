import { Tiktoken } from "tiktoken/lite";


let encoder: Tiktoken;

export function init() {
  //encoder = new Tiktoken(
  //);
  return true;
}

// Tested against:
// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb

// Implement ai21 tokenization in future .-. 
export function getTokenCount(prompt: string) {
  return { tokenizer: "tiktoken", token_count: 1 };
}

