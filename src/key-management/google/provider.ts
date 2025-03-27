import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../config";
import { logger } from "../../logger";
import axios, { AxiosError } from "axios";

// https://developers.generativeai.google/api/rest/generativelanguage/models/list
export const GOOGLE_SUPPORTED_MODELS = [
  "chat-bison-001",
  "text-bison-001",
  "embedding-gecko-001",
  "gemini-1.0-pro-latest",
  "gemini-1.0-pro",
  "gemini-pro",
  "gemini-1.0-pro-001",
  "gemini-1.0-pro-vision-latest",
  "gemini-pro-vision",
  "gemini-1.0-ultra-latest",
  "gemini-ultra",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro-001",
  "gemini-1.5-pro-002",
  "gemini-1.5-pro",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-002",
  "gemini-1.5-flash",
  // "gemini-1.5-pro-exp-0801",
  // "gemini-1.5-pro-exp-0827",
  // "gemini-1.5-flash-exp-0827",
  //"gemini-1.5-flash-8b-exp-0827",
  //"gemini-1.5-flash-8b-exp-0924",
  "gemini-1.5-flash-8b-latest",
  // "gemini-exp-1114",
  // "gemini-exp-1121",
  // "gemini-exp-1206", removed not needed routes to 2.0 pro exp
  "learnlm-1.5-pro-experimental",
  "gemini-2.0-flash-lite-preview",
  "gemini-2.0-flash-lite-preview-02-05",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash",
  "gemini-2.0-flash-thinking-exp-01-21",
  // "gemini-2.0-flash-thinking-exp-1219",
  "gemini-2.0-flash-thinking-exp",
  "gemini-2.0-pro-exp",
  "gemini-2.0-pro-exp-02-05",
  "gemini-2.5-pro-exp-03-25"
  // Embeddings maybe in future 
  // "embedding-001",
  // "text-embedding-004",
  // "aqa",
  
] as const;
export type GoogleModel = (typeof GOOGLE_SUPPORTED_MODELS)[number];

export type GoogleKeyUpdate = Omit<
  Partial<GoogleKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

export interface GoogleKey extends Key {
  readonly service: "google";
  rateLimitedAt: number;
  rateLimitedUntil: number;
  isRevoked: boolean;
  hasQuotaFlash: boolean;
  hasQuota15: boolean;
  hasQuota20Flash: boolean;
  hasQuotaExp: boolean;
  hasQuotaThinking: boolean;
  
}

/**
 * https://developers.generativeai.google/models/language < Rate limits 
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 1000; 


const KEY_REUSE_DELAY = 30000; // Rate limit is 2 for free so just give it 30 seconds per key ig for now

export class GoogleKeyProvider implements KeyProvider<GoogleKey> {
  readonly service = "google";

  private keys: GoogleKey[] = [];
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.googleKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "GOOGLE_KEY is not set. GOOGLE API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: GoogleKey = {
        key,
		org: "None",
        service: this.service,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false, 
		
		hasQuotaFlash: false,
		hasQuota15: false,
		hasQuota20Flash: false,
    hasQuota20Pro: false,
    hasQuotaFlashLite: false,
		hasQuotaThinking: false,
		hasQuotaExp: false,
		
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `google-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Google keys.");
  }
  
  public deleteKeyByHash(keyHash: string) {
	  const keyIndex = this.keys.findIndex((key) => key.hash === keyHash);
	  if (keyIndex === -1) {
		return false; // Key Not found 
	  }
	  this.keys.splice(keyIndex, 1);
	  return true; // Key successfully deleted
  }
  
  public getKeyByHash(keyHash: string) {
	  const key = this.keys.find((key) => key.hash === keyHash);
	  if (key === undefined) {
		return ["error: Not found"]; // Key Not found 
	  }
	  return key;
  }
  
  public addKey(keyValue: string) {
	  const isDuplicate = this.keys.some((key) => key.key === keyValue);
	  if (isDuplicate) {
		return false;
	  }
	  const newKey: GoogleKey = {
        key: keyValue,
		org: "None",
        service: this.service,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false,

		hasQuotaFlash: false,
		hasQuota15: false,
		hasQuota20Flash: false,
    hasQuota20Pro: false,
    hasQuotaFlashLite: false,
		hasQuotaThinking: false,
		hasQuotaExp: false,
		
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `google-${crypto
          .createHash("sha256")
          .update(keyValue)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
	  return true 
  }
  
  // change any > propper type 
  // Unfuck this whole file change google > google 
  private async checkValidity(key: any) {
	  const payload =  {"contents": [{"role": "user","parts": { "text": "test" }}], "generationConfig": {"maxOutputTokens": 1}} // Simple Prompt to check validity of request 

	  try{
		
 


		
		
		const GoogleFlash = await (async () => { 
			try { 
				const responseFlash = await axios.post(config.googleProxy+'/v1beta/models/gemini-1.5-flash:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const checkFlash = responseFlash.data && responseFlash.data["candidates"] || false// Just for check if it doesn't find it, it will raise catch. 
				if (checkFlash) {
					key.hasQuotaFlash = true 
				} 
			} catch { return false } 
		})();

		const Google15 = await (async () => { 
			try { 
				const response15 = await axios.post(config.googleProxy+'/v1beta/models/gemini-1.5-pro-latest:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const check15 = response15.data && response15.data["candidates"] || false// Just for check if it doesn't find it, it will raise catch. 
				if (check15) {
					key.hasQuota15 = true 
				} 
			} catch { return false } 
		})();
		
		const Google20Flash = await (async () => { 
			try { 
				const response20Flash = await axios.post(config.googleProxy+'/v1beta/models/gemini-2.0-flash:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const check20Flash = response20Flash.data && response20Flash.data["candidates"] || false// Just for check if it doesn't find it, it will raise catch. 
				if (check20Flash) {
					key.hasQuota20Flash = true 
				} 
			} catch { return false } 
		})();

    const Google20FlashLite = await (async () => { 
			try { 
				const response20FlashLite = await axios.post(config.googleProxy+'/v1beta/models/gemini-2.0-flash-lite-preview:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const check20FlashLite = response20FlashLite.data && response20FlashLite.data["candidates"] || false// Just for check if it doesn't find it, it will raise catch. 
				if (check20FlashLite) {
					key.hasQuotaFlashLite = true 
				} 
			} catch { return false } 
		})();

    const Google20Pro = await (async () => { 
			try { 
				const responseGoogle20Pro = await axios.post(config.googleProxy+'/v1beta/models/gemini-2.0-pro-exp:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const checkGoogle20Pro = responseGoogle20Pro.data && responseGoogle20Pro.data["candidates"] || false// Just for check if it doesn't find it, it will raise catch. 
				if (checkGoogle20Pro) {
					key.hasQuota20Pro = true 
					key.hasQuotaExp = true 
				} 
			} catch { return false } 
		})();
		
		const GoogleThinking = await (async () => { 
			try { 
				const responseThinking = await axios.post(config.googleProxy+'/v1beta/models/gemini-2.0-flash-thinking-exp:generateContent', payload, { headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key } }); 
				const checkThinking = responseThinking.data && responseThinking.data["usageMetadata"] || false// Just for check if it doesn't find it, it will raise catch. 
				
				if (checkThinking) {
					key.hasQuotaThinking = true 
				} 
			} catch { return false } 
		})();
		
		
		if (key.hasQuota15 == false && key.hasQuotaExp == false && key.hasQuota20Flash == false && key.hasQuotaThinking == false && key.hasQuota20Pro == false && key.hasQuotaFlashLite == false) {
			key.isRevoked = true;
		}
		
	  } catch (error) {
		key.isRevoked = true; // Error = revoked, will specify other states as i learn them .-. 
	  }
  }
  
  public init() {
	const promises = this.keys.map(key => this.checkValidity(key));
	return Promise.all(promises);
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: GoogleModel, applyRateLimit: boolean = true) {
	
	let filteredKeys = this.keys
	
	
	if (_model.includes("exp")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaExp);
	} else if (_model.includes("1.5")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota15);
	} else if (_model.includes("flash-lite")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaFlashLite);
	} else if (_model.includes("2.0-pro")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota20Pro);
	} else if (_model.includes("2.0-flash")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota20Flash);
	} else if (_model.includes("flash")) {
		filteredKeys = filteredKeys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaFlash);
	}
	const availableKeys = filteredKeys 

	
    if (availableKeys.length === 0) {
      throw new Error(`No Google keys with ${_model} quota available.`);
    }

    // (largely copied from the OpenAI provider, without trial key support)
    // Select a key, from highest priority to lowest priority:
    // 1. Keys which are not rate limited
    //    a. If all keys were rate limited recently, select the least-recently
    //       rate limited key.
    // 2. Keys which have not been used in the longest time

    const now = Date.now();

    const keysByPriority = availableKeys.sort((a, b) => {
      const aRateLimited = now - a.rateLimitedAt < RATE_LIMIT_LOCKOUT;
      const bRateLimited = now - b.rateLimitedAt < RATE_LIMIT_LOCKOUT;

      if (aRateLimited && !bRateLimited) return 1;
      if (!aRateLimited && bRateLimited) return -1;
      if (aRateLimited && bRateLimited) {
        return a.rateLimitedAt - b.rateLimitedAt;
      }
      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = now;
    selectedKey.rateLimitedAt = now;
    // Intended to throttle the queue processor as otherwise it will just
    // flood the API with requests and we want to wait a sec to see if we're
    // going to get a rate limit error on this key.
    selectedKey.rateLimitedUntil = now + KEY_REUSE_DELAY;
    return { ...selectedKey };
  }

  public disable(key: GoogleKey) {
    const keyFromPool = this.keys.find((k) => k.key === key.key);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<GoogleKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, update);
  }
  
  public getAllKeys() {
	  const safeKeyList = this.keys;
	  return safeKeyList
  }

  public recheck() {
	 this.keys.forEach((key) => {
			key.isDisabled = false;
	 });
	 this.init();
  }
  
  public getHashes() {
	let x: string[] = [];
	
	return x;
  }
  
  public available() {
    return this.keys.filter((k) => !k.isDisabled && !k.isRevoked).length;
  }
  
  public anyUnchecked() {
    return false;
  }

  public incrementPrompt(hash?: string) {
    const key = this.keys.find((k) => k.hash === hash);
    if (!key) return;
    key.promptCount++;
  }

  public getLockoutPeriod(_model: GoogleModel) {
    const activeKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked);
    // Don't lock out if there are no keys available or the queue will stall.
    // Just let it through so the add-key middleware can throw an error.
    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((k) => now < k.rateLimitedUntil);
    const anyNotRateLimited = rateLimitedKeys.length < activeKeys.length;

    if (anyNotRateLimited) return 0;

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((k) => k.rateLimitedUntil - now)
    );
    return timeUntilFirstReady;
  }

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve, so all we can do is wait a bit and try
   * again. We will lock the key for 2 seconds after getting a 429 before
   * retrying in order to give the other requests a chance to finish.
   */
  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public activeLimitInUsd() {
    return "∞";
  }
}
