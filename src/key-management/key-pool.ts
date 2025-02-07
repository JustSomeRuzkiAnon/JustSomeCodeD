import type * as http from "http";
import { AnthropicKeyProvider, AnthropicKeyUpdate } from "./anthropic/provider";
import { GoogleKeyProvider, GoogleKeyUpdate } from "./google/provider";
import { Ai21KeyProvider, Ai21KeyUpdate } from "./ai21/provider";
import { Key, Model, KeyProvider, AIService } from "./index";
import { OpenAIKeyProvider, OpenAIKeyUpdate } from "./openai/provider";
import { GrokKeyProvider, GrokKeyUpdate } from "./grok/provider";
import { CohereKeyProvider, CohereKeyUpdate } from "./cohere/provider";
import { MistralKeyProvider, MistralKeyUpdate } from "./mistral/provider";
import { DeepseekKeyProvider, DeepseekKeyUpdate } from "./deepseek/provider";



type AllowedPartial = OpenAIKeyUpdate | AnthropicKeyUpdate | GoogleKeyUpdate | Ai21KeyUpdate | GrokKeyUpdate | MistralKeyUpdate | DeepseekKeyUpdate | CohereKeyUpdate;

export class KeyPool {
  private keyProviders: KeyProvider[] = [];

  constructor() {
    this.keyProviders.push(new OpenAIKeyProvider());
    this.keyProviders.push(new AnthropicKeyProvider());
	this.keyProviders.push(new GoogleKeyProvider());
	this.keyProviders.push(new Ai21KeyProvider());
	this.keyProviders.push(new GrokKeyProvider());
	this.keyProviders.push(new MistralKeyProvider());
	this.keyProviders.push(new DeepseekKeyProvider());
	this.keyProviders.push(new CohereKeyProvider());
	
  }
  
  
  public init() {
    this.keyProviders.forEach((provider) => provider.init());
    const availableKeys = this.available("all");
    if (availableKeys === 0) {
      throw new Error(
        "No keys loaded. Ensure either OPENAI_KEY or ANTHROPIC_KEY or GOOGLE_KEY or AI21_KEY or Grok_KEY or MISTRAL_KEY is set."
      );
    }
  }
  
  public getKeysSafely() {
	const openaiKeys = this.keyProviders[0].getAllKeys();
	const anthropipcKeys = this.keyProviders[1].getAllKeys();
	const googleKeys = this.keyProviders[2].getAllKeys();
	const ai21Keys = this.keyProviders[3].getAllKeys();
	const grokKeys = this.keyProviders[4].getAllKeys();
    const mistralKeys = this.keyProviders[5].getAllKeys();
	const deepseekKeys = this.keyProviders[6].getAllKeys();
	const cohereKeys = this.keyProviders[7].getAllKeys();

	const combinedKeys = Array.prototype.concat.call(openaiKeys, anthropipcKeys, googleKeys, ai21Keys, grokKeys, mistralKeys, deepseekKeys);
	return combinedKeys;
  }
  
  public addKey(key: string) {
	  const openaiProvider = this.keyProviders[0]
	  const anthropicProvider = this.keyProviders[1]
	  const googleProvider = this.keyProviders[2]
	  const ai21Provider = this.keyProviders[3]
	  const grokProvider = this.keyProviders[4];
	  const mistralProvider = this.keyProviders[5]
	  const deepseekProvider = this.keyProviders[6]
	  const cohereProvider = this.keyProviders[7]
	  
	  let val = false
	  if (key.includes("sk-ant-api") || key.startsWith("AKIA")) {
		val = anthropicProvider.addKey(key);
	  } else if (key.includes("sk-") || key.includes(".azure.")) {
		if (key === key.toLowerCase()) {
			val = deepseekProvider.addKey(key);
		} else {
			val = openaiProvider.addKey(key);
		}
	  } else if (key.startsWith("AIzaSy")) {
		val = googleProvider.addKey(key);
	  } else if (key.startsWith("xai-")) {
		val = grokProvider.addKey(key);
	  } else if (key.startsWith("MAKIA")) {
		val = mistralProvider.addKey(key.slice(1));
	  } else {
		  val = mistralProvider.addKey(key);
	  }

	  return val;
	  
  }
  public getKeyByHash(keyHash: string) {
	const openaiProvider = this.keyProviders[0]
	const anthropicProvider = this.keyProviders[1]
	const googleProvider = this.keyProviders[2]
	const ai21Provider = this.keyProviders[3]
	const grokProvider = this.keyProviders[4]
	const mistralProvider = this.keyProviders[5]
	const deepseekProvider = this.keyProviders[6]
	const cohereProvider = this.keyProviders[7]
	
	
	
	const prefix = keyHash.substring(0, 3);

	if (prefix === 'oai') {
		let key = openaiProvider.getKeyByHash(keyHash);
		return key  
	} else if (prefix === 'ant') { 
    	let key = anthropicProvider.getKeyByHash(keyHash);
		return key 
	} else if (prefix === 'pal') { 
    	let key = googleProvider.getKeyByHash(keyHash);
		return key 
	} else if (prefix === 'ai2') { 
    	let key = ai21Provider.getKeyByHash(keyHash);
		return key
	} else if (prefix === 'xai') { 
    	let key = grokProvider.getKeyByHash(keyHash);
		return key
	} else if (prefix === 'mist') { 
    	let key = mistralProvider.getKeyByHash(keyHash);
		return key
	} else if (prefix === 'dee') { 
    	let key = deepseekProvider.getKeyByHash(keyHash);
		return key
	} else if (prefix === 'coh') { 
    	let key = cohereProvider.getKeyByHash(keyHash);
		return key
	}else {
		return false
	}
	
  
  }
  
  public deleteKeyByHash(keyHash: string) {
	const openaiProvider = this.keyProviders[0]
	const anthropicProvider = this.keyProviders[1]
	const googleProvider = this.keyProviders[2]
	const ai21Provider = this.keyProviders[3]
	const grokProvider = this.keyProviders[4]
	const mistralProvider = this.keyProviders[5]
	const deepseekProvider = this.keyProviders[6]
	const cohereProvider = this.keyProviders[7]
	
	const prefix = keyHash.substring(0, 3);
	if (prefix === 'oai') {
		openaiProvider.deleteKeyByHash(keyHash);
		return true 
	} else if (prefix === 'ant') { 
    	anthropicProvider.deleteKeyByHash(keyHash);
		return true 
	} else if (prefix === 'pal') { 
    	googleProvider.deleteKeyByHash(keyHash);
		return true 
	} else if (prefix === 'ai2') { 
    	ai21Provider.deleteKeyByHash(keyHash);
		return true 	
	} else if (prefix === 'xai') { 
    	grokProvider.deleteKeyByHash(keyHash);
		return true 	
	} else if (prefix === 'mis') { 
    	mistralProvider.deleteKeyByHash(keyHash);
		return true 	
	} else if (prefix === 'dee') { 
    	deepseekProvider.deleteKeyByHash(keyHash);
		return true 	
	} else if (prefix === 'coh') { 
    	cohereProvider.deleteKeyByHash(keyHash);
		return true 	
	} else {
		// Nothing invalid key, shouldn't be possible (Maybe in future handle error)
		return false
	}
  }
  
  
  public getHashes() {
	const combinedHashes: string[] = [];
	this.keyProviders.forEach((provider) => {
		const hashes = provider.getHashes();
		combinedHashes.push(...hashes);
	})
	
	return combinedHashes;
  }
  
  
  public recheck() {
	this.keyProviders.forEach((provider) => {
		provider.recheck();
	})
	const availableKeys = this.available("all");
  }

  public get(model: Model, applyRateLimit: boolean = true): Key {
    const service = this.getService(model);
	return this.getKeyProvider(service).get(model, applyRateLimit);
  }
  

  public list(): Omit<Key, "key">[] {
    return this.keyProviders.flatMap((provider) => provider.list());
  }

  public disable(key: Key, reason: "quota" | "revoked"): void {
    const service = this.getKeyProvider(key.service);
    service.disable(key);
    if (service instanceof OpenAIKeyProvider || service instanceof GrokKeyProvider || service instanceof MistralKeyProvider) {
      service.update(key.hash, {
        isRevoked: reason === "revoked",
        isOverQuota: reason === "quota",
      });
    }
  }

  public update(key: Key, props: AllowedPartial): void {
    const service = this.getKeyProvider(key.service);
    service.update(key.hash, props);
  }

  public available(service: AIService | "all" = "all"): number {
    return this.keyProviders.reduce((sum, provider) => {
      const includeProvider = service === "all" || service === provider.service;
      return sum + (includeProvider ? provider.available() : 0);
    }, 0);
  }

  public anyUnchecked(): boolean {
    return this.keyProviders.some((provider) => provider.anyUnchecked());
  }

  public incrementPrompt(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.incrementPrompt(key.hash);
  }

  public getLockoutPeriod(model: Model): number {
    const service = this.getService(model);
    return this.getKeyProvider(service).getLockoutPeriod(model);
  }

  public markRateLimited(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.markRateLimited(key.hash);
  }

  public updateRateLimits(key: Key, headers: http.IncomingHttpHeaders): void {
    const provider = this.getKeyProvider(key.service);
    if (provider instanceof OpenAIKeyProvider || provider instanceof GrokKeyProvider) {
      provider.updateRateLimits(key.hash, headers);
    }
  }



  private getService(model: Model): AIService {
	if (model.includes("bison") || model.includes("gemini") || model.includes("learnlm")) {
	  return "google";
	} else if (model.startsWith("j2-")) {
      return "ai21";
    } else if (model.startsWith("gpt") || model.startsWith("dall-") || model.startsWith("text-embedding-") || model.startsWith("chatgpt") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("tts-")) {
      return "openai";
    } else if (model.startsWith("claude-") || model.startsWith("anthropic.")) {
      return "anthropic";
    } else if (model.startsWith("mistral") || model.startsWith("mixtral") || model.startsWith("open-")) {
      return "mistral";
    } else if (model.startsWith("grok")) {
      return "grok";
    } else if (model.startsWith("deepseek")) {
      return "deepseek";
    } else if (model.startsWith("command") || model.startsWith("c4ai")) {
      return "cohere";
    }
	
	
    throw new Error(`Unknown service for model '${model}'`);
  }

  private getKeyProvider(service: AIService): KeyProvider {
    return this.keyProviders.find((provider) => provider.service === service)!;
  }
}
