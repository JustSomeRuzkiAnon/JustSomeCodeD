/* Manages Cohere API keys. Tracks usage, disables expired keys, and provides
round-robin access to keys. Keys are stored in the Cohere_KEY environment
variable as a comma-separated list of keys. */
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { v4 as uuid } from "uuid";
import { KeyProvider, Key, Model } from "../index";
import { config } from "../../config";
import { logger } from "../../logger";
import { CohereKeyChecker } from "./checker";

export type CohereModel = "command-r7b-12-2024" | "command-r-plus-08-2024" | "command-r-plus-04-2024" | "command-r-plus" | "command-r-08-2024" | "command-r-03-2024" | "command-r" | "command" | "command-nightly" | "command-light" | "command-light-nightly" | "c4ai-aya-expanse-8b" |	"c4ai-aya-expanse-32b";

export const Cohere_SUPPORTED_MODELS: readonly CohereModel[] = [
	"command-r7b-12-2024",
	"command-r-plus-08-2024",
	"command-r-plus-04-2024",
	"command-r-plus",
	"command-r-08-2024",
	"command-r-03-2024",
	"command-r",
	"command",
	"command-nightly",
	"command-light",
	"command-light-nightly",
	"c4ai-aya-expanse-8b",
	"c4ai-aya-expanse-32b"
] as const;

export interface CohereKey extends Key {
  readonly service: "cohere";
  /** Set when key check returns a 401. */
  isRevoked: boolean;
  /** Set when key check returns a non-transient 429. */
  isOverQuota: boolean;
  /** Threshold at which a warning email will be sent by Cohere. */
  softLimit: number;
  /** Threshold at which the key will be disabled because it has reached the user-defined limit. */
  hardLimit: number;
  /** The maximum quota allocated to this key by Cohere. */
  systemHardLimit: number;
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  rateLimitRequestsReset: number;
  rateLimitTokensReset: number;
}

export type CohereKeyUpdate = Omit<
  Partial<CohereKey>,
  "key" | "hash" | "promptCount"
>;

export class CohereKeyProvider implements KeyProvider<CohereKey> {
  readonly service = "cohere" as const;

  private keys: CohereKey[] = [];
  private checker?: CohereKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyString = config.cohereKey?.trim();
    if (!keyString) {
      this.log.warn("Cohere_KEY is not set. Cohere API will not be available.");
      return;
    }
    let bareKeys: string[];
    bareKeys = keyString.split(",").map((k) => k.trim());
    bareKeys = [...new Set(bareKeys)];
    for (const k of bareKeys) {
      const newKey = {
        key: k,
		org: "default",
        service: "cohere" as const,
        isGpt4: false,
		isGpt432k: false,
        isTrial: false,
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
		isSpecial: false,
		specialMap: {},
        softLimit: 0,
        hardLimit: 0,
        systemHardLimit: 0,
        usage: 0,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
		// Changing hash to uid sorry but annoying to work with if one key can have multiple profiles 
        hash: `coh-${crypto
          .createHash("sha256")
          .update(k)
          .digest("hex")}`,
        rateLimitedAt: 0,
        rateLimitRequestsReset: 0,
        rateLimitTokensReset: 0,
		organizations: {},
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Cohere keys.");
  }
  
  public getHashes() {
	  this.checker = new CohereKeyChecker(this.keys, this.update.bind(this), this.createKey.bind(this));
	  let x: string[] = [];
	  this.keys.forEach((key) => {
			x.push(key.hash);
	   });
	  return x 
  }
  
  public addKey(keyValue: string) {
	  const isDuplicate = this.keys.some((key) => key.key === keyValue);
	  if (isDuplicate) {
		return false;
	  }
	  const newKey = {
        key: keyValue,
		org: "default",
        service: "cohere" as const,
        isGpt4: false,
		isGpt432k: false,
		isGpt4Turbo: false,
        isTrial: false,
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
		isSpecial: false,
        softLimit: 0,
        hardLimit: 0,
        systemHardLimit: 0,
        usage: 0,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
        hash: `coh-${crypto
          .createHash("sha256")
          .update(keyValue)
          .digest("hex")}`,
        rateLimitedAt: 0,
        rateLimitRequestsReset: 0,
        rateLimitTokensReset: 0,
		organizations: {},
		specialMap: {},
      };
      this.keys.push(newKey);
	  return true 
  }
  
  public recheck() {
	  this.checker = new CohereKeyChecker(this.keys, this.update.bind(this), this.createKey.bind(this));
	  this.keys.forEach((key) => {
			key.isDisabled = false;
			key.isOverQuota = false; 
			key.isRevoked = false;
			key.lastChecked = 0;
	   });
      this.checker.start();
  }
  
  public getAllKeys() {
	  const safeKeyList = this.keys 
	  return safeKeyList
  }
  

  public init() {
    if (config.checkKeys) {
      this.checker = new CohereKeyChecker(this.keys, this.update.bind(this), this.createKey.bind(this));
      this.checker.start();
    }
  }

  /**
   * Returns a list of all keys, with the key field removed.
   * Don't mutate returned keys, use a KeyPool method instead.
   **/
  public list() {
    return this.keys.map((key) => {
      return Object.freeze({
        ...key,
        key: undefined,
      });
    });
  }

  public get(model: Model, applyRateLimit: boolean = true) {

    let availableKeys = this.keys.filter(
		  (key) => !key.isDisabled 
		);
	

    const now = Date.now();
    const rateLimitThreshold = 60 * 1000;
	
	let selectedKey = undefined; 
	let keysByPriority = undefined;
	
	
	keysByPriority = availableKeys.sort((a, b) => {
	  const aRateLimited = now - a.rateLimitedAt < rateLimitThreshold;
	  const bRateLimited = now - b.rateLimitedAt < rateLimitThreshold;

	  if (aRateLimited && !bRateLimited) return 1;
	  if (!aRateLimited && bRateLimited) return -1;
	  if (aRateLimited && bRateLimited) {
		return a.rateLimitedAt - b.rateLimitedAt;
	  }

	  if (a.isTrial && !b.isTrial) return -1;
	  if (!a.isTrial && b.isTrial) return 1;

	  return a.lastUsed - b.lastUsed;
	});


	selectedKey = keysByPriority[0];
	
	if (selectedKey == undefined) {
		let message = "No active Cohere keys available.";
		throw new Error(message);
	}
	
	
	if (applyRateLimit) {
		selectedKey.lastUsed = now;
		selectedKey.rateLimitedAt = now;
		selectedKey.rateLimitRequestsReset = 1000;
	}
    return { ...selectedKey };
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

  public createKey(key: any) {

	  const hashExists = this.keys.some(item => item.hash === key.hash );
	  if (hashExists) {  
	  } else {
		this.keys.push(key)
	  }
  }
  /** Called by the key checker to update key information. */
  public update(keyHash: string, update: CohereKeyUpdate) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
    // this.writeKeyStatus();
  }

  /** Disables a key, or does nothing if the key isn't in this pool. */
  public disable(key: Key) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public anyUnchecked() {
    return !!config.checkKeys && this.keys.some((key) => !key.lastChecked);
  }

  /**
   * Given a model, returns the period until a key will be available to service
   * the request, or returns 0 if a key is ready immediately.
   */
  public getLockoutPeriod(model: Model = "command-light"): number {

	let activeKeys = [] 

	activeKeys = this.keys.filter(
	  (key) => !key.isDisabled
	);
	
		

    if (activeKeys.length === 0) {
      return 0;
    }

    // A key is rate-limited if its `rateLimitedAt` plus the greater of its
    // `rateLimitRequestsReset` and `rateLimitTokensReset` is after the
    // current time.

    // If there are any keys that are not rate-limited, we can fulfill requests.
    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((key) => {
      const resetTime = Math.max(
        key.rateLimitRequestsReset,
        key.rateLimitTokensReset
      );
      return now < key.rateLimitedAt + resetTime;
    }).length;
    const anyNotRateLimited = rateLimitedKeys < activeKeys.length;

    if (anyNotRateLimited) {
      return 0;
    }

    // If all keys are rate-limited, return the time until the first key is
    // ready.
    const timeUntilFirstReady = Math.min(
      ...activeKeys.map((key) => {
        const resetTime = Math.max(
          key.rateLimitRequestsReset,
          key.rateLimitTokensReset
        );
        return key.rateLimitedAt + resetTime - now;
      })
    );
    return timeUntilFirstReady;
  }

  public markRateLimited(keyHash: string) {
    this.log.warn({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.rateLimitedAt = Date.now();
  }

  public incrementPrompt(keyHash?: string) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;
    key.promptCount++;
  }

  public updateRateLimits(keyHash: string, headers: http.IncomingHttpHeaders) {
    const key = this.keys.find((k) => k.hash === keyHash)!;
	const requestsReset = headers["x-ratelimit-reset-requests"];
	const tokensReset = headers["x-ratelimit-reset-tokens"];

	if (requestsReset && typeof requestsReset === "string") {
	  this.log.info(
		{ key: key.hash, requestsReset },
		`Updating rate limit requests reset time`
	  );
	  key.rateLimitRequestsReset = getResetDurationMillis(requestsReset);
	}
	if (tokensReset && typeof tokensReset === "string") {
	  this.log.info(
		{ key: key.hash, tokensReset },
		`Updating rate limit tokens reset time`
	  );
	  key.rateLimitTokensReset = getResetDurationMillis(tokensReset);
	}
	
	if (!requestsReset && !tokensReset) {
	  this.log.warn(
		{ key: key.hash },
		`No rate limit headers in Cohere response; skipping update`
	  );
	  return;
	}


  }

}

/**
 * Converts reset string ("21.0032s" or "21ms") to a number of milliseconds.
 * Result is clamped to 10s even though the API returns up to 60s, because the
 * API returns the time until the entire quota is reset, even if a key may be
 * able to fulfill requests before then due to partial resets.
 **/
function getResetDurationMillis(resetDuration?: string): number {
  const match = resetDuration?.match(/(\d+(\.\d+)?)(s|ms)/);
  if (match) {
    const [, time, , unit] = match;
    const value = parseFloat(time);
    const result = unit === "s" ? value * 1000 : value;
    return Math.min(result, 10000);
  }
  return 0;
}
