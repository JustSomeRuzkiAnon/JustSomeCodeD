import dotenv from "dotenv";
import pino from "pino";
import crypto from 'crypto';

dotenv.config();


function generateSalt(length: number): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

// Can't import the usual logger here because it itself needs the config.
const startupLogger = pino({ level: "debug" }).child({ module: "startup" });

const isDev = process.env.NODE_ENV !== "production";

type PromptLoggingBackend = "google_sheets";
export type DequeueMode = "fair" | "random" | "none";

type Config = {
  /** Custom Accept Reject Responses */
  responseOnUnauthorized: string;
  restrictedModelMessage: string;
  page_body?: string;
  googleProxy: string;
  promptInjections?: object;
  /** The port the proxy server will listen on. */
  port: number;
  /** Comma-delimited list of OpenAI API keys. */
  openaiKey?: string;
  /** Comma-delimited list of Google API keys */
  googleKey?: string;
  /** Comma-delimited list of Ai21 API keys  */
  ai21Key?: string; 
  /** Comma-delimited list of Grok API keys  */
  grokKey?: string; 
  deepseekKey?: string;
  cohereKey?: string;

  disabledModels?: string;
  disabledGptModels?: string;
  
  /** Comma-delimited list of [redacted] API keys  */

  
  /** Comma-delimited list of Mistral API keys  */
  mistralKey?: string;
  
  
  togetherKey?: string;

  /** Required for dall-e gens */
  imgBBKey?: string; 
  ImageExpiry?: number;
  
  
  /** Comma-delimited list of Anthropic/Aws API keys. */
  anthropicKey?: string;
  salt: string;
  /**
   * The proxy key to require for requests. Only applicable if the user
   * management mode is set to 'proxy_key', and required if so.
   **/
  proxyKey?: string;

  disableUserStats: boolean;
  /**
   * The admin key used to access the /admin API. Required if the user
   * management mode is set to 'user_token'.
   **/
  adminKey?: string;
  /**
   * Which user management mode to use.
   *
   * `none`: No user management. Proxy is open to all requests with basic
   *  abuse protection.
   *
   * `proxy_key`: A specific proxy key must be provided in the Authorization
   *  header to use the proxy.
   *
   * `user_token`: Users must be created via the /admin REST API and provide
   *  their personal access token in the Authorization header to use the proxy.
   *  Configure this function and add users via the /admin API.
   */
  gatekeeper: "none" | "proxy_key" | "user_token";
  /**
   * Persistence layer to use for user management.
   *
   * `memory`: Users are stored in memory and are lost on restart (default)
   * 
   * `json`: Users are stored in a JSON file
   *
   **/
  gatekeeperStore: "memory" | "json";
  /** The json file to store users in if `json` gatekeeperStore is active */
  usersJson?: string;
  /**
   * Maximum number of IPs per user, after which their token is disabled.
   * Users with the manually-assigned `special` role are exempt from this limit.
   * By default, this is 0, meaning that users are not IP-limited.
   */
  maxIpsPerUser: number;
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
  /**
   * For OpenAI, the maximum number of context tokens (prompt + max output) a
   * user can request before their request is rejected.
   * Context limits can help prevent excessive spend.
   * Defaults to 0, which means no limit beyond OpenAI's stated maximums.
   */
  maxContextTokensOpenAI: number;
  /**
   * For Anthropic, the maximum number of context tokens a user can request.
   * Claude context limits can prevent requests from tying up concurrency slots
   * for too long, which can lengthen queue times for other users.
   * Defaults to 0, which means no limit beyond Anthropic's stated maximums.
   */
  maxContextTokensAnthropic: number;
  maxContextTokensGoogle: number;
  maxContextTokensMistral: number;
  /** For OpenAI, the maximum number of sampled tokens a user can request. */
  maxOutputTokensOpenAI: number;
  /** For Anthropic, the maximum number of sampled tokens a user can request. */
  maxOutputTokensAnthropic: number;
  maxOutputTokensGoogle: number;
  maxOutputTokensMistral: number;
  
  /** Pino log level. */
  logLevel?: "debug" | "info" | "warn" | "error";

  /** Google Sheets spreadsheet ID. */
  googleSheetsSpreadsheetId?: string;
  /** Whether to periodically check keys for usage and validity. */
  checkKeys?: boolean;
  /**
   * How to display quota information on the info page.
   *
   * `none`: Hide quota information
   *
   * `partial`: (deprecated) Same as `full` because usage is no longer tracked
   *
   * `full`: Displays information about keys' quota limits
   */
  quotaDisplayMode: "none" | "full";
  /**
   * Which request queueing strategy to use when keys are over their rate limit.
   *
   * `fair`: Requests are serviced in the order they were received (default)
   *
   * `random`: Requests are serviced randomly
   *
   * `none`: Requests are not queued and users have to retry manually
   */
  queueMode: DequeueMode;

  /**
   * Whether the proxy should disallow requests for GPT-4 models in order to
   * prevent excessive spend.  Applies only to OpenAI.
   */
  turboOnly?: boolean;
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  salt: generateSalt(16),
  responseOnUnauthorized: getEnvWithDefault("RESPONSE_ON_UNAUTHORIZED", "Unauthorized Access"),
  restrictedModelMessage: getEnvWithDefault("RESTRICTED_MODEL_MESSAGE", "You are not allowed to use this type of models."),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  googleKey: getEnvWithDefault("GOOGLE_KEY", ""),
  ai21Key: getEnvWithDefault("AI21_KEY", ""),
  grokKey: getEnvWithDefault("GROK_KEY", ""),
  deepseekKey: getEnvWithDefault("DEEPSEEK_KEY", ""),
  cohereKey: getEnvWithDefault("COHERE_KEY", ""),
  
  imgBBKey: getEnvWithDefault("IMGBB_KEY", ""),
  ImageExpiry: getEnvWithDefault("IMAGE_EXPIRY", 604800),
  
  mistralKey: getEnvWithDefault("MISTRAL_KEY", ""),
  togetherKey: getEnvWithDefault("TOGETHER_KEY", ""),
  page_body: atob(getEnvWithDefault("PAGE_BODY", "YDwhRE9DVFlQRSBodG1sPgo8aHRtbCBsYW5nPSJlbiI+CiAgPGhlYWQ+CiAgICA8bWV0YSBjaGFyc2V0PSJ1dGYtOCIgLz4KICAgIDxtZXRhIG5hbWU9InJvYm90cyIgY29udGVudD0ibm9pbmRleCIgLz4KICAgIDx0aXRsZT57dGl0bGV9PC90aXRsZT4KICA8L2hlYWQ+CiAgPGJvZHkgc3R5bGU9ImZvbnQtZmFtaWx5OiBzYW5zLXNlcmlmOyBiYWNrZ3JvdW5kLWNvbG9yOiAjZjBmMGYwOyBwYWRkaW5nOiAxZW07Ij4KICAgIHtoZWFkZXJIdG1sfQogICAgPGhyIC8+CiAgICA8aDI+U2VydmljZSBJbmZvPC9oMj4KICAgIDxwcmU+e0pTT059PC9wcmU+CiAgPC9ib2R5PgogIDxiIGlkPSJ1YyI+CiAgPGEgaHJlZj0iL3VzZXIvbG9naW4iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iYmFja2dyb3VuZC1jb2xvcjogIzRDQUY1MDtib3JkZXI6IG5vbmU7Y29sb3I6IHdoaXRlO3BhZGRpbmc6IDE1cHggMzJweDt0ZXh0LWFsaWduOiBjZW50ZXI7dGV4dC1kZWNvcmF0aW9uOiBub25lO2Rpc3BsYXk6IGlubGluZS1ibG9jaztmb250LXNpemU6IDE2cHg7bWFyZ2luOiA0cHggMnB4O2N1cnNvcjogcG9pbnRlcjsiIGhpZGRlbj5DaGVjayB1c2VyX3Rva2VuPC9hPgogIDwvYj4KICA8c2NyaXB0PgogIGxldCBnYXRla2VlcGVyID0gIntjb25maWc6Z2F0ZWtlZXBlcn0iCiAgaWYgKGdhdGVrZWVwZXIgPT0gInVzZXJfdG9rZW4iKSB7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidWMiKS5oaWRkZW4gPSBmYWxzZTsKICB9CiAgPC9zY3JpcHQ+CjwvaHRtbD5gCg==")),
  promptInjections: JSON.parse(atob(getEnvWithDefault("PROMPT_INJECTIONS", "e30="))),
  googleProxy: atob(getEnvWithDefault("GOOGLE_PROXY", "aHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20=")),
  anthropicKey: getEnvWithDefault("ANTHROPIC_KEY", ""),
  disableUserStats: getEnvWithDefault("DISABLE_USER_STATS", false),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  adminKey: getEnvWithDefault("ADMIN_KEY", ""),
  gatekeeper: getEnvWithDefault("GATEKEEPER", "none"),
  gatekeeperStore: getEnvWithDefault("GATEKEEPER_STORE", "memory"),
  usersJson: getEnvWithDefault("USERS_JSON", undefined),
  maxIpsPerUser: getEnvWithDefault("MAX_IPS_PER_USER", 0),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 4),

  disabledModels: getEnvWithDefault("DISABLED_MODELS", ""),
  disabledGptModels: getEnvWithDefault("DISABLED_GPT_MODELS", ""),
  
  // Max input 
  maxContextTokensOpenAI: getEnvWithDefault("MAX_CONTEXT_TOKENS_OPENAI", 0),
  maxContextTokensAnthropic: getEnvWithDefault("MAX_CONTEXT_TOKENS_ANTHROPIC", 0),
  maxContextTokensGoogle: getEnvWithDefault("MAX_CONTEXT_TOKENS_GOOGLE", 0),
  maxContextTokensMistral: getEnvWithDefault("MAX_CONTEXT_TOKENS_MISTRAL", 0),
  
  // Max output 
  maxOutputTokensOpenAI: getEnvWithDefault("MAX_OUTPUT_TOKENS_OPENAI", 8192),
  maxOutputTokensAnthropic: getEnvWithDefault("MAX_OUTPUT_TOKENS_ANTHROPIC", 2048 ),
  maxOutputTokensGoogle: getEnvWithDefault("MAX_OUTPUT_TOKENS_GOOGLE", 4096 ),
  maxOutputTokensMistral: getEnvWithDefault("MAX_OUTPUT_TOKENS_MISTRAL", 2048 ),
  
  
  logLevel: getEnvWithDefault("LOG_LEVEL", "info"),
  checkKeys: getEnvWithDefault("CHECK_KEYS", !isDev),
  quotaDisplayMode: getEnvWithDefault("QUOTA_DISPLAY_MODE", "full"),
  queueMode: getEnvWithDefault("QUEUE_MODE", "fair"),
  turboOnly: getEnvWithDefault("TURBO_ONLY", false),
} as const;

function migrateConfigs() {
  let migrated = false;
  const deprecatedMax = process.env.MAX_OUTPUT_TOKENS;

  if (!process.env.MAX_OUTPUT_TOKENS_OPENAI && deprecatedMax) {
    migrated = true;
    config.maxOutputTokensOpenAI = parseInt(deprecatedMax);
  }
  if (!process.env.MAX_OUTPUT_TOKENS_ANTHROPIC && deprecatedMax) {
    migrated = true;
    config.maxOutputTokensAnthropic = parseInt(deprecatedMax);
  }

  if (migrated) {
    startupLogger.warn(
      {
        MAX_OUTPUT_TOKENS: deprecatedMax,
        MAX_OUTPUT_TOKENS_OPENAI: config.maxOutputTokensOpenAI,
        MAX_OUTPUT_TOKENS_ANTHROPIC: config.maxOutputTokensAnthropic,
      },
      "`MAX_OUTPUT_TOKENS` has been replaced with separate `MAX_OUTPUT_TOKENS_OPENAI` and `MAX_OUTPUT_TOKENS_ANTHROPIC` configs. You should update your .env file to remove `MAX_OUTPUT_TOKENS` and set the new configs."
    );
  }
}

/** Prevents the server from starting if config state is invalid. */
export async function assertConfigIsValid() {
  migrateConfigs();

  // Ensure gatekeeper mode is valid.
  if (!["none", "proxy_key", "user_token"].includes(config.gatekeeper)) {
    throw new Error(
      `Invalid gatekeeper mode: ${config.gatekeeper}. Must be one of: none, proxy_key, user_token.`
    );
  }

  // Don't allow `user_token` mode without `ADMIN_KEY`.
  if (config.gatekeeper === "user_token" && !config.adminKey) {
    throw new Error(
      "`user_token` gatekeeper mode requires an `ADMIN_KEY` to be set."
    );
  }

  // Don't allow `proxy_key` mode without `PROXY_KEY`.
  if (config.gatekeeper === "proxy_key" && !config.proxyKey) {
    throw new Error(
      "`proxy_key` gatekeeper mode requires a `PROXY_KEY` to be set."
    );
  }

  // Don't allow `PROXY_KEY` to be set for other modes.
  if (config.gatekeeper !== "proxy_key" && config.proxyKey) {
    throw new Error(
      "`PROXY_KEY` is set, but gatekeeper mode is not `proxy_key`. Make sure to set `GATEKEEPER=proxy_key`."
    );
  }

  if (
    config.gatekeeperStore === "json" &&
    (!config.usersJson)
  ) {
    throw new Error(
      "`json` store requires USERS_JSON"
    );
  }

  // Ensure forks which add new secret-like config keys don't unwittingly expose
  // them to users.
  for (const key of getKeys(config)) {
    const maybeSensitive = ["key", "credentials", "secret", "password"].some(
      (sensitive) => key.toLowerCase().includes(sensitive)
    );
    const secured = new Set([...SENSITIVE_KEYS, ...OMITTED_KEYS]);
    if (maybeSensitive && !secured.has(key))
      throw new Error(
        `Config key "${key}" may be sensitive but is exposed. Add it to SENSITIVE_KEYS or OMITTED_KEYS.`
      );
  }

}

/**
 * Config keys that are masked on the info page, but not hidden as their
 * presence may be relevant to the user due to privacy implications.
 */
export const SENSITIVE_KEYS: (keyof Config)[] = ["googleSheetsSpreadsheetId"];

/**
 * Config keys that are not displayed on the info page at all, generally because
 * they are not relevant to the user or can be inferred from other config.
 */
export const OMITTED_KEYS: (keyof Config)[] = [
  "port",
  "logLevel",
  "salt",
  "openaiKey",
  "googleKey",
  "ai21Key", 
  "imgBBKey",
  "grokKey",
  "deepseekKey",
  "cohereKey",
  "mistralKey",
  "togetherKey",
  "anthropicKey",
  "proxyKey",
  "adminKey",
  "checkKeys",
  "quotaDisplayMode",
  "gatekeeperStore",
  "maxIpsPerUser",
  "googleProxy"
];

const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;

export function listConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of getKeys(config)) {
    const value = config[key]?.toString() || "";

    const shouldOmit =
      OMITTED_KEYS.includes(key) || value === "" || value === "undefined";
    const shouldMask = SENSITIVE_KEYS.includes(key);

    if (shouldOmit) {
      continue;
    }

    if (value && shouldMask) {
      result[key] = "********";
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getEnvWithDefault<T>(name: string, defaultValue: T): T {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  try {
    if (name === "OPENAI_KEY" || name === "ANTHROPIC_KEY" || name === "GOOGLE_KEY" || name === "TOGETHER_KEY" || name == "MISTRAL_KEY" || name == "DEEPSEEK_KEY" || name == "COHERE_KEY" || name == "GROK_KEY") {
      return value as unknown as T;
    }
    return JSON.parse(value) as T;
  } catch (err) {
    return value as unknown as T;
  }
}