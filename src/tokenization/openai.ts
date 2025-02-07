import { Tiktoken } from "tiktoken/lite";
import cl100k_base from "tiktoken/encoders/cl100k_base.json";
import sharp from "sharp";


let encoder: Tiktoken;

export function init() {
  encoder = new Tiktoken(
    cl100k_base.bpe_ranks,
    cl100k_base.special_tokens,
    cl100k_base.pat_str
  );
  return true;
}

// Tested against:
// https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb

export function getTokenCount(messages: any[], model: string) {
  const gpt4 = model.startsWith("gpt-4") || model.startsWith("chatgpt");

  const tokensPerMessage = gpt4 ? 3 : 4;
  const tokensPerName = gpt4 ? 1 : -1; // turbo omits role if name is present

  let numTokens = 0;

  for (const message of messages) {
    numTokens += tokensPerMessage;
    for (const key of Object.keys(message)) {
      const value = message[key];
      if (key === "content") {
        if (value) {
          if (typeof value === 'string') {
            if (value.length > 1500000 || numTokens > 262144) {
              numTokens = 262144;
              return {
                tokenizer: "tiktoken (prompt length limit exceeded)",
                token_count: numTokens,
              };
            }

            numTokens += encoder.encode(value).length;
          } else if (typeof value === 'object') {
            for (const value_key of Object.keys(value)) {
              if (value_key === "text") {
                numTokens += encoder.encode(value[value_key]).length;
              } else if (value_key === "image_url") {
                (async () => {
                  numTokens += await getGpt4VisionTokenCost(value[value_key]["url"], value[value_key]["detail"])
                })();
              }
            }
          }
        }
      } else if (key === "tool_calls") { // a little bit inaccurate because of the special tokens but its close enough
        if (value) {
          for (const tool_call of value) {
            if (tool_call.type === "function") {
              numTokens += encoder.encode(tool_call.function.arguments).length; 
              numTokens += encoder.encode(tool_call.function.name).length;
            }
          }
        }
      }
    }
  }
  numTokens += 3; // every reply is primed with <|start|>assistant<|message|>
  return { tokenizer: "tiktoken", token_count: numTokens };
}


// Yoinked from khanon and modified thanks ._.
async function getGpt4VisionTokenCost(
  url: string,
  detail: "auto" | "low" | "high" = "auto"
): Promise<number> {
  // For now we do not allow remote images as the proxy would have to download
  // them, which is a potential DoS vector.
  if (!url.startsWith("data:image/")) {
    throw new Error(
      "Remote images are not supported. Add the image to your prompt as a base64 data URL."
    );
  }
  
  const base64Data = url.split(",")[1];
  const buffer = Buffer.from(base64Data, "base64");
  const image = sharp(buffer);
  const metadata = await image.metadata();

  if (!metadata || !metadata.width || !metadata.height) {
    throw new Error("Prompt includes an image that could not be parsed");
  }

  const { width, height } = metadata;

  let selectedDetail: "low" | "high";
  if (detail === "auto") {
    const threshold = 512 * 512;
    const imageSize = width * height;
    selectedDetail = imageSize > threshold ? "high" : "low";
  } else {
    selectedDetail = detail;
  }

  // https://platform.openai.com/docs/guides/vision/calculating-costs
  if (selectedDetail === "low") {
    return 85;
  }

  let newWidth = width;
  let newHeight = height;
  if (width > 2048 || height > 2048) {
    const aspectRatio = width / height;
    if (width > height) {
      newWidth = 2048;
      newHeight = Math.round(2048 / aspectRatio);
    } else {
      newHeight = 2048;
      newWidth = Math.round(2048 * aspectRatio);
    }
  }

  if (newWidth < newHeight) {
    newHeight = Math.round((newHeight / newWidth) * 768);
    newWidth = 768;
  } else {
    newWidth = Math.round((newWidth / newHeight) * 768);
    newHeight = 768;
  }

  const tiles = Math.ceil(newWidth / 512) * Math.ceil(newHeight / 512);
  const tokens = 170 * tiles + 85;

  return tokens;
}

// Modify the OpenAIPromptMessage type to align with the expected structure
export type OpenAIPromptMessage = {
  name?: string;
  content: string | { type: string; text?: string; image_url?: string }[];
  role: string;
  tool_calls?: {
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: 'function';
  }[];
};
