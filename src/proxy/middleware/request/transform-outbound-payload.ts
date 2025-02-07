import { Request } from "express";
import { z } from "zod";
import { config } from "../../../config";
import { OpenAIPromptMessage } from "../../../tokenization";
import { isCompletionRequest } from "../common";
import { RequestPreprocessor } from ".";

const CLAUDE_OUTPUT_MAX = config.maxOutputTokensAnthropic;
const OPENAI_OUTPUT_MAX = config.maxOutputTokensOpenAI;


// Openai embeds types:

const OpenaiEmbedRequestSchema = z.object({
  input: z.string(),
  model: z.string(),
});

const EmbeddingSchema = z.object({
  object: z.literal('embedding'),
  index: z.number(),
  embedding: z.array(z.number()),
});

const OpenaiEmbedRepsonseSchema = z.object({
  object: z.literal('list'),
  data: z.array(EmbeddingSchema),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});

export type OpenaiEmbedResponse = z.infer<typeof OpenaiEmbedRepsonseSchema>;
export type OpenaiEmbedRequest = z.infer<typeof OpenaiEmbedRequestSchema>;

const AnthropicV1MessageMultimodalContentSchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      source: z.object({
        type: z.literal("base64"),
        media_type: z.string().max(100),
        data: z.string(),
      }),
    }),
  ])
);


export const AnthropicV1CompleteSchema = z.object({
  model: z.string().regex(/^claude-/, "Model must start with 'claude-'"),
  messages: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string(),
          AnthropicV1MessageMultimodalContentSchema,
        ]),
      })
    ),
  max_tokens: z.number().int().transform((v) => Math.min(v, CLAUDE_OUTPUT_MAX)),
  metadata: z.any().optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  top_k: z.number().optional().default(0),
  stop_sequences: z.union([z.string(), z.array(z.string())]).optional(),
  system: z.string().optional(),
  anthropic_version: z.string(),
});



  
// https://platform.openai.com/docs/api-reference/chat/create
const MessageTypeSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().optional(),
    }),
  }),
]);

const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.union([
      z.object({
        role: z.enum(["system", "user", "assistant", "model"]),
        content: z.string(),
        name: z.string().optional(),
      }),
      z.object({
        role: z.enum(["system", "user", "assistant", "model"]),
        content: z.array(MessageTypeSchema).nonempty(), // Ensure the array is not empty
        name: z.string().optional(),
      }),
    ]),
    {
      required_error:
        "No messages found. Are you using update frontend that supports /messages?",
      invalid_type_error:
        "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
    }
  ),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  n: z
    .literal(1, {
      errorMap: () => ({
        message: "You may only request a single completion at a time.",
      }),
    })
    .optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.coerce
    .number()
    .int()
    .optional()
    .default(2048)
    .transform((v) => Math.min(v, OPENAI_OUTPUT_MAX)),
  max_completion_tokens: z.coerce
    .number()
    .int()
    .optional()
    .default(2048)
    .transform((v) => Math.min(v, OPENAI_OUTPUT_MAX)),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
});

// Text 
const OpenAIV1TextCompletionSchema = z
  .object({
    model: z
      .string()
      .regex(
        /^gpt-3.5-turbo-instruct/,
        "Model must start with 'gpt-3.5-turbo-instruct'"
      ),
    prompt: z.string({
      required_error:
        "No `prompt` found. Ensure you've set the correct completion endpoint.",
    }),
    logprobs: z.number().int().nullish().default(null),
    echo: z.boolean().optional().default(false),
    best_of: z.literal(1).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    suffix: z.string().optional(),
  })
  .merge(OpenAIV1ChatCompletionSchema.omit({ messages: true }));

// https://developers.generativeai.google/api/python/google/generativeai/generate_text
const GoogleChatCompletionSchema = z.object({ // Sorry khanon for borrowing it :v but ffs i don't want to write it out myself ._. 
  model: z.string(), //actually specified in path but we need it for the router
  contents: z.array(
    z.object({
      parts: z.array(z.object({ text: z.string() })),
      role: z.enum(["user", "model"]),
    })
  ),
  tools: z.array(z.object({})).max(0).optional(),
  safetySettings: z.array(z.object({})).max(0).optional(),
  stopSequences: z.array(z.string()).max(5).optional(),
  generationConfig: z.object({
    temperature: z.number().optional(),
    maxOutputTokens: z.coerce
      .number()
      .int()
      .optional()
      .default(16)
      .transform((v) => Math.min(v, 1024)), // TODO: Add config
    candidateCount: z.literal(1).optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    stopSequences: z.array(z.string()).max(5).optional(),
  }),
});

const Ai21ChatCompletionSchema = z.object({
  model: z.string(),
  prompt: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No prompt found. Are you sending an Anthropic-formatted request to the OpenAI endpoint?",
      invalid_type_error:
        "Messages were not formatted correctly. Refer to the OpenAI Chat API documentation for more information.",
    }
  ),
  temperature: z.number().optional().default(1),
  numResults: z.number().optional().default(1),
  stop_sequences: z.union([z.string(), z.array(z.string())]).optional(),
  maxTokens: z.coerce
    .number()
    .int()
    .optional()
    .default(16)
    .transform((v) => Math.max(v, OPENAI_OUTPUT_MAX)),
  topP: z.number().optional(),
  topKReturn: z.number().optional()
});


/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable = !isCompletionRequest(req);
  
  if (req.inboundApi == "anthropic" && req.outboundApi == "anthropic") {
	return 
  }

  if (req.inboundApi == "google" && req.outboundApi == "google") {
	return 
  }
  
  if (req.inboundApi == "openai" && req.outboundApi == "openai") {
	return 
  }
  
  if (req.inboundApi == "openai" && req.outboundApi == "grok") {
	return 
  }
  
  if (req.inboundApi == "openai" && req.outboundApi == "deepseek") {
	return 
  }
  
  if (req.inboundApi == "openai" && req.outboundApi == "cohere") {
	return 
  }
  
  if (req.inboundApi == "mistral" && req.outboundApi == "mistral") {
	return 
  }
  
  if (alreadyTransformed || notTransformable) {
    return;
  }

  
  if (sameService && !req.body.model.includes("text-embedding-")) {
	
	const validator =
	  req.outboundApi === "openai"
		? OpenAIV1ChatCompletionSchema
		: OpenAIV1TextCompletionSchema;
	const result = validator.safeParse(req.body);
	
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    req.body = result.data;
    return;
  }



  //if (req.inboundApi === "openai" && req.outboundApi === "openai-text") {
  //  req.body = openaiToOpenaiText(req);
  //  return;
  //}
  
  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = await openaiToAnthropic(req.body, req);
    return;
  }
  
  if (req.inboundApi === "openai" && req.outboundApi === "google") {
    req.body = await openaiToGoogle(req.body, req);
    return;
  }
  
  if (req.inboundApi === "openai" && req.outboundApi === "ai21") {
    req.body = await openaiToAi21(req.body, req);
    return;
  }


  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

async function openaiToAi21(body: any, req: Request) {
	// ai 21 removed.
}

function openaiToOpenaiText(req: Request) {
  // text completion removed 
}

const GoogleAIV1GenerateContentSchema = z.object({
  model: z.string(), //actually specified in path but we need it for the router
  stream: z.boolean().optional().default(false), // also used for router
  contents: z.array(
    z.object({
      parts: z.array(
		  z.object({
			text: z.string(),
			inlineData: z.optional(
			  z.object({
				mimeType: z.string(),
				data: z.string(),
			  })
			),
		  })
		),
      role: z.enum(["user", "model"]),
    })
  ),
  tools: z.array(z.object({})).max(0).optional(),
  safetySettings: z.array(z.object({})).max(0).optional(),
  generationConfig: z.object({
    temperature: z.number().optional(),
    maxOutputTokens: z.coerce
      .number()
      .int()
      .optional()
      .default(16)
      .transform((v) => Math.min(v, 8192)), // TODO: Add config
    candidateCount: z.literal(1).optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    stopSequences: z.array(z.string()).max(5).optional(),
  }),
});



export type GoogleAIChatMessage = z.infer<
  typeof GoogleAIV1GenerateContentSchema
>["contents"][0];


async function openaiToGoogle(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Google request"
    );
    throw result.error;
  }
  
  const { messages, ...rest } = result.data;
  const foundNames = new Set<string>();
  const contents = messages
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const text = flattenOpenAIMessageContent(m.content);
      const propName = m.name?.trim();
      const textName =
        m.role === "system" ? "" : text.match(/^(.{0,50}?): /)?.[1]?.trim();
      const name =
        propName || textName || (role === "model" ? "Character" : "User");

      foundNames.add(name);

      const textPrefix = textName ? "" : `${name}: `;
      return {
        parts: [{ text: textPrefix + text }],
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      };
    })
    .reduce<GoogleAIChatMessage[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (last?.role === msg.role) {
        last.parts[0].text += "\n\n" + msg.parts[0].text;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push(...Array.from(foundNames).map((name) => `\n${name}:`));
  stops = [...new Set(stops)].slice(0, 5);

  let googleSafetySettings = [
	  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
	  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, 
	  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
	  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }
	]

  return {
	model: rest.model,
    contents,
	stream: rest.stream,
    tools: [],
    generationConfig: {
      maxOutputTokens: rest.max_tokens,
      stopSequences: stops,
      topP: rest.top_p,
      topK: 40, // openai schema doesn't have this, geminiapi defaults to 40
      temperature: rest.temperature
    },
    safetySettings: googleSafetySettings.map(setting => ({
        ...setting,
        threshold: rest.model.includes("gemini-2.0-flash-exp") ? "OFF" : setting.threshold // change if needed 
    }))
	
  };
}

async function openaiToAnthropic(body: any, req: Request) {
  // not supported 
}



function flattenOpenAiChatMessages(messages: OpenAIPromptMessage[]) {
  // Temporary to allow experimenting with prompt strategies
  const PROMPT_VERSION: number = 1;
  switch (PROMPT_VERSION) {
    case 1:
      return (
        messages
          .map((m) => {
            // Claude-style human/assistant turns
            let role: string = m.role;
            if (role === "assistant") {
              role = "Assistant";
            } else if (role === "system") {
              role = "System";
            } else if (role === "user") {
              role = "User";
            }
            return `\n\n${role}: ${m.content}`;
          })
          .join("") + "\n\nAssistant:"
      );
    case 2:
      return messages
        .map((m) => {
          // Claude without prefixes (except system) and no Assistant priming
          let role: string = "";
          if (role === "system") {
            role = "System: ";
          }
          return `\n\n${role}${m.content}`;
        })
        .join("");
    default:
      throw new Error(`Unknown prompt version: ${PROMPT_VERSION}`);
  }
}


export type OpenAIChatMessage = z.infer<
  typeof OpenAIV1ChatCompletionSchema
>["messages"][0];

function flattenOpenAIMessageContent(
  content: OpenAIChatMessage["content"]
): string {
  return Array.isArray(content)
    ? content
        .map((contentItem) => {
          if (contentItem) { // Check if contentItem is not undefined
            if ("text" in contentItem) return contentItem.text;
            if ("image_url" in contentItem) return "[ Uploaded Image Omitted ]";
          }
        })
        .filter(Boolean) // Remove any undefined items from the array
        .join("\n")
    : content;
}