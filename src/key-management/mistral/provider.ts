import crypto from "crypto";
import { Key, KeyProvider } from "..";
import { config } from "../../config";
import { logger } from "../../logger";
import axios, { AxiosError } from "axios";


export const MISTRAL_SUPPORTED_MODELS = [
// Excluded any deprecated production models.
// 32k 
"codestral-latest",
"codestral-2405",

"open-mistral-7b",
"open-mixtral-8x7b",

"mistral-small-latest",
"mistral-small-2501",

// 64k 
"open-mixtral-8x22b",

// 128k
"mistral-large-latest",
"mistral-large-2411",
"mistral-large-2407",
"mistral-large-2402",

"pixtral-large-latest",
"pixtral-large-2411",
"pixtral-12b-2409",

"open-mistral-nemo",
"open-mistral-nemo-2407",

"ministral-3b-latest",
"ministral-3b-2410",
// 256k
"open-codestral-mamba",

//AWS
"mistral.mistral-large-2407-v1:0",
"mistral.mistral-large-2402-v1:0",

] as const;
export type MistralModel = (typeof MISTRAL_SUPPORTED_MODELS)[number];

export type MistralKeyUpdate = Omit<
  Partial<MistralKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

export interface MistralKey extends Key {
  readonly service: "mistral";
  rateLimitedAt: number;
  rateLimitedUntil: number;
  isRevoked: boolean;
  isAws: boolean; 
  awsSecret?: string;
  awsRegion?: string; 
}


const RATE_LIMIT_LOCKOUT = 1000; // Rate limit is 90 (750 is for 90 currently it's set to 80)
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class MistralKeyProvider implements KeyProvider<MistralKey> {
  readonly service = "mistral";

  private keys: MistralKey[] = [];
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.mistralKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "MISTRAL_KEY is not set. Mistral API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (let key of bareKeys) {
      let isAws = false 
	  let awsSecret = ""
	  let awsRegion = ""
	  if (key.startsWith("AKIA")) {
		isAws = true;
		const spliced = key.split(":");
		key = spliced[0] 
		awsSecret = spliced[1]
		awsRegion = spliced[2] 
	  }	
	  const newKey: MistralKey = {
        key,
		org: "None",
        service: this.service,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false, 
		isPozzed: false,
		isAws: isAws,
        awsRegion: awsRegion ?? "",
		awsSecret: awsSecret ?? "", 
		promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `mist-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Mistral/Mistral AWS keys.");
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
	  
	  let isAws = false 
	  let awsSecret = ""
	  let awsRegion = ""
	  let keyFinalValue = keyValue
	  if (keyValue.startsWith("AKIA")) {
		keyFinalValue = keyFinalValue // no overlap ._. for claude
		isAws = true;
		const spliced = keyValue.split(":");
		keyFinalValue = spliced[0] 
		awsSecret = spliced[1]
		awsRegion = spliced[2] 
	  }	
	  const newKey: MistralKey = {
        key: keyFinalValue,
		org: "None",
        service: this.service,
		isAws: isAws,
		awsSecret: awsSecret ?? "",
		awsRegion: awsRegion ?? "",
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
		isRevoked: false, 
		isPozzed: false, 
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `mist-${crypto
          .createHash("sha256")
          .update(keyValue)
          .digest("hex")}`,
        lastChecked: 0,
      };
      this.keys.push(newKey);
	  return true 
  }
  
  // change any > propper type 
  private async checkValidity(key: any) {
	  if (!key.isAws) {
		  const payload =  {"model": "mistral-large-latest", "messages": [{"role": "user","content": "text" }], max_tokens: 1} // Simple Prompt to check validity of request 
		  try{

			const response = await axios.post(
				'https://api.mistral.ai/v1/chat/completions', payload, { headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${key.key}` } }
			);
			const check = response.data && response.data["choices"] || false// Just for check if it doesn't find it, it will raise catch. 
			if (check) {
			} else {
				key.isRevoked = true 
			}
			
		  } catch (error) {

			key.isRevoked = true; // Error = revoked, will specify other states as i learn them .-. 
		  }
	  }
  }
  
  public init() {
	const promises = this.keys.map(key => this.checkValidity(key));
	return Promise.all(promises);
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: MistralModel, applyRateLimit: boolean = true) {
    const availableKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked);
	const onlyAwsKeys = this.keys.filter((k) => !k.isDisabled && !k.isRevoked && k.isAws);
	const awsChatAllowed = ["mistral-large-latest", "mistral-large-2407", "mistral-large-2402"]
		
	
	
	
	
    if (availableKeys.length === 0 && onlyAwsKeys.length === 0) {
      throw new Error("No Mistral/AWS keys available.");
    }
	
	if (availableKeys.length === 0 && onlyAwsKeys.length != 0 && !(_model in awsChatAllowed) ) {
		throw new Error(`AWS key doesn't support {_model} model.`);
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
	
	if (applyRateLimit) {
		selectedKey.lastUsed = now;
		selectedKey.rateLimitedAt = now;
		selectedKey.rateLimitedUntil = now + KEY_REUSE_DELAY;
	}
	
    return { ...selectedKey };
  }

  public disable(key: MistralKey) {
    const keyFromPool = this.keys.find((k) => k.key === key.key);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<MistralKey>) {
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

  public getLockoutPeriod(_model: MistralModel) {
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
