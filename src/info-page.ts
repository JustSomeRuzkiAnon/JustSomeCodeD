import fs from "fs";
import { Request, Response } from "express";
import showdown from "showdown";
import { config, listConfig } from "./config";
import { GrokKey, GoogleKey, OpenAIKey, CohereKey, keyPool } from "./key-management";
import { gptVariants } from  "./proxy/openai";
import { getUniqueIps } from "./proxy/rate-limit";
import { getPublicUsers, getGlobalTokenCount, getClaudeTokenCount, getOpenaiTokenCount } from "./proxy/auth/user-store"; 
import {
  QueuePartition,
  getEstimatedWaitTime,
  getQueueLength,
} from "./proxy/queue";

const INFO_PAGE_TTL = 5000;
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;


export function handleStatusPage(_req: Request) {
  return getStatusJson(_req);
};

export const handleInfoPage = (req: Request, res: Response) => {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    res.send(infoPageHtml);
    return;
  }

  // Sometimes huggingface doesn't send the host header and makes us guess.
  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");

  res.send(cacheInfoPageHtml(baseUrl));
};

function cacheInfoPageHtml(baseUrl: string) {
  const keys = keyPool.list();

  const openaiKeys = Math.min(keys.filter((k) => k.service === "openai").length, 1);
  const anthropicKeys = Math.min(keys.filter((k) => k.service === "anthropic").length, 1);
  const googleKeys = Math.min(keys.filter((k) => k.service === "google").length, 1);
  const grokKeys = Math.min(keys.filter((k) => k.service === "grok").length, 1);
  const cohereKeys = Math.min(keys.filter((k) => k.service === "cohere").length, 1);
  const mistralKeys = Math.min(keys.filter((k) => k.service === "mistral").length, 1);
  const ai21Keys = Math.min(keys.filter((k) => k.service === "ai21").length, 1);

  const info = {
    uptime: process.uptime(),
    endpoints: {
	  ...({ universal: baseUrl + "/proxy" }), // use only universal one 
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    openaiKeys,
    anthropicKeys,
	googleKeys,
	ai21Keys,
	mistralKeys,
    ...(openaiKeys ? getOpenAIInfo() : {}),
    ...(anthropicKeys ? getAnthropicInfo() : {}),
	...(googleKeys ? getGoogleInfo() : {}),
	...(mistralKeys ? getMistralInfo(): {}),
	...(grokKeys ? getGrokInfo() : {}),
	...(cohereKeys ? getCohereInfo() : {}),
    ...(ai21Keys ? getAi21Info() : {}),
    config: listConfig(),
    build: process.env.BUILD_INFO || "dev",
  };



  const title = getServerTitle();
  const headerHtml = buildInfoPageHeader(new showdown.Converter(), title);

  const temp_info = structuredClone(info)
  // For Json info 
  delete temp_info.config.page_body
  delete temp_info.config.responseOnUnauthorized
  delete temp_info.config.promptInjections
  
  const openai_info = getOpenAIInfo()
  const google_info = getGoogleInfo()
  const mistral_info = getMistralInfo()
  const ai21_info = getAi21Info()
  const grok_info = getGrokInfo()
  
  
  const anthropic_info = getAnthropicInfo()
  
  const public_user_info = getPublicUsers();
  



  infoPageHtml = info.config.page_body
		.replaceAll("{headerHtml}", headerHtml)
		.replaceAll("{user:data}", JSON.stringify(public_user_info).toString())
		.replaceAll("{title}", title)
		.replaceAll("{JSON}", JSON.stringify(temp_info, null, 2))
		.replaceAll("{uptime}", info?.uptime?.toString())
		 .replaceAll("{endpoints:universal}",info?.endpoints.universal ?? "Not Available" )
		 .replaceAll("{azure:moderatedModels}", JSON.stringify(openai_info.azure?.moderatedModels, null, 2) ?? "{}")
		 .replaceAll("{azure:unmoderatedModels}", JSON.stringify(openai_info.azure?.unmoderatedModels, null, 2) ?? "{}")
		 .replaceAll("{proompts}", info?.proompts?.toString() ?? "0")
		 .replaceAll("{proomptersNow}",info?.proomptersNow?.toString() ?? "0")
		 .replaceAll("{openaiKeys}", (substring: string) => info.openaiKeys.toString())
		 .replaceAll("{anthropicKeys}", (substring: string) => info.anthropicKeys.toString() )
		 .replaceAll("{googleKeys}", (substring: string) => info.googleKeys.toString())
		 .replaceAll("{ai21Keys}", (substring: string) => info.ai21Keys.toString() )
		 .replaceAll("{status}", (substring: string) => openai_info.status.toString() ?? "Checking finished")
		 .replaceAll("{google:activeKeys}", (substring: string) => google_info.google?.activeKeys?.toString() ?? "0")
		 .replaceAll("{google:proomptersInQueue}",(substring: string) => google_info.google?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{google:estimatedQueueTime}", (substring: string) => google_info.google?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{google:revokedKeys}", (substring: string) => google_info.google?.revokedKeys?.toString() ?? "0")
     .replaceAll("{mistral:activeKeys}", (substring: string) => mistral_info.mistral?.activeKeys?.toString() ?? "0")
		 .replaceAll("{mistral:proomptersInQueue}",(substring: string) => mistral_info.mistral?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{mistral:estimatedQueueTime}", (substring: string) => mistral_info.mistral?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{mistral:revokedKeys}", (substring: string) => mistral_info.mistral?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{ai21:activeKeys}", (substring: string) => ai21_info.ai21?.activeKeys?.toString() ?? "0")
		 .replaceAll("{ai21:proomptersInQueue}",(substring: string) => ai21_info.ai21?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{ai21:estimatedQueueTime}", (substring: string) => ai21_info.ai21?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{ai21:revokedKeys}", (substring: string) => ai21_info.ai21?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{turbo:activeKeys}", (substring: string) => openai_info.turbo?.activeKeys?.toString() ?? "0")
		 .replaceAll("{turbo:proomptersInQueue}",(substring: string) => openai_info.turbo?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{turbo:estimatedQueueTime}", (substring: string) => openai_info.turbo?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{turbo:revokedKeys}", (substring: string) => openai_info.turbo?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{turbo:overQuotaKeys}", (substring: string) => openai_info.turbo?.overQuotaKeys?.toString() ?? "0")
		 .replaceAll("{gpt4:activeKeys}",(substring: string) => openai_info.gpt4?.activeKeys?.toString() ?? "0")
		 .replaceAll("{gpt4:overQuotaKeys}",(substring: string) => openai_info.gpt4?.overQuotaKeys?.toString() ?? "0")
		 .replaceAll("{gpt4:revokedKeys}",(substring: string) => openai_info.gpt4?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{gpt4:proomptersInQueue}",(substring: string) => openai_info.gpt4?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{gpt4:estimatedQueueTime}",(substring: string) => openai_info.gpt4?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{grok:activeKeys}",(substring: string) => openai_info.gpt4?.activeKeys?.toString() ?? "0")
		 .replaceAll("{grok:overQuotaKeys}",(substring: string) => grok_info.grok?.overQuotaKeys?.toString() ?? "0")
		 .replaceAll("{grok:revokedKeys}",(substring: string) => grok_info.grok?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{grok:proomptersInQueue}",(substring: string) => grok_info.grok?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{grok:estimatedQueueTime}",(substring: string) => grok_info.grok?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{gpt432k:activeKeys}",(substring: string) => openai_info.gpt4_32k?.activeKeys?.toString() ?? "0")
		 .replaceAll("{gpt432k:overQuotaKeys}",(substring: string) => openai_info.gpt4_32k?.overQuotaKeys?.toString() ?? "0")
		 .replaceAll("{gpt432k:revokedKeys}",(substring: string) => openai_info.gpt4_32k?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{gpt432k:proomptersInQueue}",(substring: string) => openai_info.gpt4_32k?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{gpt432k:estimatedQueueTime}",(substring: string) => openai_info.gpt4_32k?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{gpt4_turbo:activeKeys}",(substring: string) => openai_info.gpt4_turbo?.activeKeys?.toString() ?? "0")
		 .replaceAll("{gpt4_turbo:overQuotaKeys}",(substring: string) => openai_info.gpt4_turbo?.overQuotaKeys?.toString() ?? "0")
		 .replaceAll("{gpt4_turbo:revokedKeys}",(substring: string) => openai_info.gpt4_turbo?.revokedKeys?.toString() ?? "0")
		 .replaceAll("{gpt4_turbo:proomptersInQueue}",(substring: string) => openai_info.gpt4_turbo?.proomptersInQueue?.toString() ?? "0")
		 .replaceAll("{gpt4_turbo:estimatedQueueTime}",(substring: string) => openai_info.gpt4_turbo?.estimatedQueueTime?.toString() ?? "Not Available")
		 .replaceAll("{globalTokenCount}",(substring: string) => getGlobalTokenCount().toString())
		 .replaceAll("{openaiTokenCount}",(substring: string) => getOpenaiTokenCount().toString())
		 .replaceAll("{anthropicTokenCount}",(substring: string) => getClaudeTokenCount().toString())
		 .replaceAll("{config:gatekeeper}",(substring: string) => info.config.gatekeeper).replace("{config:modelRateLimit}", (substring: string) => info.config.modelRateLimit?.toString())
		 
		 .replaceAll("{config:maxOutputTokensOpenAI}",(substring: string) => info.config.maxOutputTokensOpenAI.toString())
		 .replaceAll("{config:maxOutputTokensGoogle}",(substring: string) => info.config.maxOutputTokensGoogle.toString())
		 .replaceAll("{config:maxOutputTokensMistral}",(substring: string) => info.config.maxOutputTokensMistral.toString())
		 .replaceAll("{config:maxOutputTokensAnthropic}",(substring: string) => info.config.maxOutputTokensAnthropic.toString())
		 
		 .replaceAll("{config:maxContextTokensOpenAI}",(substring: string) => info.config.maxContextTokensOpenAI.toString())
		 .replaceAll("{config:maxContextTokensAnthropic}",(substring: string) => info.config.maxContextTokensAnthropic.toString())
		 .replaceAll("{config:maxContextTokensGoogle}",(substring: string) => info.config.maxContextTokensGoogle.toString())
		 .replaceAll("{config:maxContextTokensMistral}",(substring: string) => info.config.maxContextTokensMistral.toString())
		 
         .replaceAll("{config:promptLogging}",(substring: string) => info.config.promptLogging)
		 .replaceAll("{config:queueMode}", (substring: string) => info.config.queueMode.toString() ?? "Fair")
		 .replaceAll("{build}",info.build)
     .replaceAll('{anthropic:activeKeys}', (substring: string) => anthropic_info.claude?.activeKeys?.toString() ?? "0")
	 .replaceAll('{anthropic:revokedKeys}', (substring: string) => anthropic_info.claude?.revokedKeys?.toString() ?? "0")
	 .replaceAll('{anthropic:disabledKeys}', (substring: string) => anthropic_info.claude?.disabledKeys?.toString() ?? "0")
	 .replaceAll('{anthropic:awsKeys}', (substring: string) => anthropic_info.claude?.awsKeys?.toString() ?? "0")
     .replaceAll('{anthropic:proomptersInQueue}', (substring: string) => anthropic_info.claude?.proomptersInQueue?.toString() ?? "0")
     .replaceAll('{anthropic:estimatedQueueTime}', (substring: string) => anthropic_info.claude?.estimatedQueueTime?.toString() ?? "No wait");
  infoPageLastUpdated = Date.now();

  return infoPageHtml;
}

function getStatusJson(req: Request) {
  const keys = keyPool.list();
  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");


  const openaiKeys = Math.min(keys.filter((k) => k.service === "openai").length, 1);
  const anthropicKeys = Math.min(keys.filter((k) => k.service === "anthropic").length, 1);
  const googleKeys = Math.min(keys.filter((k) => k.service === "google").length, 1);
  const mistralKeys = Math.min(keys.filter((k) => k.service === "mistral").length, 1);
  const grokKeys = Math.min(keys.filter((k) => k.service === "grok").length, 1);
  const ai21Keys = Math.min(keys.filter((k) => k.service === "ai21").length, 1);
  const cohereKeys = Math.min(keys.filter((k) => k.service === "cohere").length, 1);
  
  const info = {
    uptime: process.uptime(),
    endpoints: {
      ...({ universal: baseUrl + "/proxy" })
    },
    proompts: keys.reduce((acc, k) => acc + k.promptCount, 0),
    ...(config.modelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
    openaiKeys,
    anthropicKeys,
	googleKeys,
	grokKeys,
	cohereKeys,
	ai21Keys,
	mistralKeys,
    ...(openaiKeys ? getOpenAIInfo() : {}),
    ...(anthropicKeys ? getAnthropicInfo() : {}),
	...(googleKeys ? getGoogleInfo() : {}), 
	...(mistralKeys ? getMistralInfo() : {}), 
	...(grokKeys ? getGrokInfo() : {}), 
	...(cohereKeys ? getCohereInfo(): {}),
	...(ai21Keys ? getAi21Info() : {}),
    config: listConfig(),
    build: process.env.BUILD_INFO || "dev",
  };
  return info 
}

type ServiceInfo = {
  activeKeys: number;
  awsKeys?: number;
  trialKeys?: number;
  disabledKeys: number;
  // activeLimit: string;
  revokedKeys?: number;
  pozzedKeys?: number;
  overQuotaKeys?: number;
  proomptersInQueue: number;
  estimatedQueueTime: string;
  status: string;
  moderatedModels?: { [key: string]: number };
  unmoderatedModels?: { [key: string]: number };
  
  // Gemini 
  hasQuotaFlash?: number;
  hasQuota10?: number;
  hasQuota15?: number;
  hasQuota20Flash?: number;
  hasQuotaExp?: number;
  hasQuotaThinking?: number;
   
  estimatedQueueTimeExp?: string;
  proomptersInQueueExp?: number;
  estimatedQueueTime15?: string;
  proomptersInQueue15?: number;
  estimatedQueueTimeFlash?: string;
  proomptersInQueueFlash?: number;

};


function getAi21Info() {
  const ai21Info: Partial<ServiceInfo> = {};
  const keys = keyPool.list().filter((k) => k.service === "ai21");
  ai21Info.activeKeys = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked).length, 1);
  ai21Info.revokedKeys = Math.min(keys.filter((k) => k.isRevoked).length, 1);
  if (config.queueMode !== "none") {
    const queue = getQueueInformation("ai21");
    ai21Info.proomptersInQueue = queue.proomptersInQueue;
    ai21Info.estimatedQueueTime = queue.estimatedQueueTime;
  }
  return { ai21: ai21Info };
}

function getGoogleInfo() {
  const googleInfo: Partial<ServiceInfo> = {};
  const keys = keyPool.list().filter((k) => k.service === "google");
  googleInfo.activeKeys = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked).length, 1);
  googleInfo.hasQuotaFlash = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaFlash).length, 1);
  googleInfo.hasQuota10 = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota10).length, 1);
  googleInfo.hasQuota15 = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota15).length, 1);
  googleInfo.hasQuota20Flash = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuota20Flash).length, 1);
  googleInfo.hasQuotaThinking = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaThinking).length, 1);
  googleInfo.hasQuotaExp = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked && k.hasQuotaExp).length, 1);


  googleInfo.revokedKeys = Math.min(keys.filter((k) => k.isRevoked).length, 1);
  if (config.queueMode !== "none") {
    const ExpQueue = getQueueInformation("google-exp");
    googleInfo.proomptersInQueueExp = ExpQueue.proomptersInQueue;
    googleInfo.estimatedQueueTimeExp = ExpQueue.estimatedQueueTime;
    const Queue15 = getQueueInformation("google-15");
    googleInfo.proomptersInQueue15 = Queue15.proomptersInQueue;
    googleInfo.estimatedQueueTime15 = Queue15.estimatedQueueTime;
    const FlashQueue = getQueueInformation("google-flash");
    googleInfo.proomptersInQueueFlash = FlashQueue.proomptersInQueue;
    googleInfo.estimatedQueueTimeFlash = FlashQueue.estimatedQueueTime;
	const Flash20Queue = getQueueInformation("google-20-flash");
    googleInfo.proomptersInQueueFlash = Flash20Queue.proomptersInQueue;
    googleInfo.estimatedQueueTimeFlash = Flash20Queue.estimatedQueueTime;
	const ThinkingQueue = getQueueInformation("google-thinking");
    googleInfo.proomptersInQueueFlash = ThinkingQueue.proomptersInQueue;
    googleInfo.estimatedQueueTimeFlash = ThinkingQueue.estimatedQueueTime;
	

  }

  return { google: googleInfo };
}

function getMistralInfo() {
  const mistralInfo: Partial<ServiceInfo> = {};
  const keys = keyPool.list().filter((k) => k.service === "mistral");
  mistralInfo.activeKeys = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked).length, 1);
  mistralInfo.revokedKeys = Math.min(keys.filter((k) => k.isRevoked).length, 1);
  if (config.queueMode !== "none") {
    const queue = getQueueInformation("mistral");
    mistralInfo.proomptersInQueue = queue.proomptersInQueue;
    mistralInfo.estimatedQueueTime = queue.estimatedQueueTime;
  }
  return { mistral: mistralInfo };
}

// this has long since outgrown this awful "dump everything in a <pre> tag" approach
// but I really don't want to spend time on a proper UI for this right now

interface SpecialMap {
  [key: string]: string;
}

interface Models extends Array<string> {}


interface AzureKey {
  specialMap?: SpecialMap;
  models?: Models,
}



function getOpenAIInfo() {
  const info: { [model: string]: Partial<ServiceInfo> } = {};
  const keys = keyPool
    .list()
    .filter((k) => k.service === "openai") as OpenAIKey[];
  const hasGpt4 = keys.some((k) => k.isGpt4) && !config.turboOnly;
  const hasGpt432k = keys.some((k) => k.isGpt432k) && !config.turboOnly;
  const hasGptO = keys.some((k) => k.isGptO) && !config.turboOnly;
  const hasGpt4Turbo = keys.some((k) => k.isGpt4Turbo) && !config.turboOnly;
  
  
  const azureKeys = keys.filter(k => k.specialMap && typeof k.specialMap === 'object' && Object.keys(k.specialMap).length > 0);
  const gptKeys = keys.filter(k => k.models && typeof k.models === 'object' && Object.keys(k.models).length > 0);
  const hasAzureKeys = azureKeys.length > 0;
  
  if (keyPool.anyUnchecked()) {
    const uncheckedKeys = keys.filter((k) => !k.lastChecked);
    info.status =
      `Performing startup key checks (${uncheckedKeys.length} left).` as any;
  } else {
    info.status = `Finished checking keys.` as any;
  }

  if (config.checkKeys) {
    const turboKeys = keys.filter((k) => !k.isGpt4 && !k.isGpt432k);
    const gpt4Keys = keys.filter((k) => k.isGpt4 && !k.isGpt432k);
	const gpt432kKeys = keys.filter((k) => k.isGpt432k);
	const gptOKeys = keys.filter((k) => k.isGptO);
	const gpt4turboKeys = keys.filter((k) => k.isGpt4Turbo);

	// Azure keys
	
	
	
	// Initialize counts
	const moderatedModelsCount: { [key: string]: number } = {};
	const unmoderatedModelsCount: { [key: string]: number } = {};

	// Iterate over keys to count models
	azureKeys.forEach((key: AzureKey) => {
	  if (key.specialMap && typeof key.specialMap === 'object') {
		Object.keys(key.specialMap).forEach((model: string) => {
		  if (model.endsWith('-moderated')) {
			moderatedModelsCount[model] = Math.min((moderatedModelsCount[model] || 0) + 1, 1);
		  } else {
			unmoderatedModelsCount[model] = Math.min((unmoderatedModelsCount[model] || 0) + 1, 1);
		  }
		});
	  }
	});
	
	
	gptKeys.forEach((key: AzureKey) => {
		if (key.models && Array.isArray(key.models)) {
			key.models.forEach((model: string) => {
				if (gptVariants.includes(model)) {
					unmoderatedModelsCount[model] = Math.min((unmoderatedModelsCount[model] || 0) + 1, 1);
				}
			});
		}
	});
		
	

    const quota: Record<string, string> = { turbo: "", gpt4: "" };


	

    info.turbo = {
      activeKeys: Math.min(turboKeys.filter((k) => !k.isDisabled).length, 1),
      revokedKeys: Math.min(turboKeys.filter((k) => k.isRevoked).length, 1),
      overQuotaKeys: Math.min(turboKeys.filter((k) => k.isOverQuota).length, 1),
    };
	
	if (hasAzureKeys) {
		info.models = {
			moderatedModels: moderatedModelsCount,
			unmoderatedModels: unmoderatedModelsCount
		
		}
	}

    if (hasGpt4) {
      info.gpt4 = {
        activeKeys: Math.min(gpt4Keys.filter((k) => !k.isDisabled && !k.hash.includes("-org")).length, 1),
        revokedKeys: Math.min(gpt4Keys.filter((k) => k.isRevoked).length, 1),
        overQuotaKeys: Math.min(gpt4Keys.filter((k) => k.isOverQuota).length, 1),
      };
    }
	
	if (hasGpt432k) {
		info.gpt4_32k = {
        activeKeys: Math.min(gpt432kKeys.filter((k) => !k.isDisabled).length, 1),
        revokedKeys: Math.min(gpt432kKeys.filter((k) => k.isRevoked).length, 1),
        overQuotaKeys: Math.min(gpt432kKeys.filter((k) => k.isOverQuota).length, 1),
      };
		
	}
	
	if (hasGptO) {
		info.gpto = {
        activeKeys: Math.min(gptOKeys.filter((k) => !k.isDisabled).length, 1),
        revokedKeys: Math.min(gptOKeys.filter((k) => k.isRevoked).length, 1),
        overQuotaKeys: Math.min(gptOKeys.filter((k) => k.isOverQuota).length, 1),
      };
		
	}
	
	if (hasGpt4Turbo) {
		info.gpt4_turbo = {
        activeKeys: Math.min(gpt4turboKeys.filter((k) => !k.isDisabled).length, 1),
        revokedKeys: Math.min(gpt4turboKeys.filter((k) => k.isRevoked).length, 1),
        overQuotaKeys: Math.min(gpt4turboKeys.filter((k) => k.isOverQuota).length, 1),
      };
		
	}

    if (config.quotaDisplayMode === "none") {
      // delete info.turbo?.activeLimit;
      // delete info.gpt4?.activeLimit;
    }
  } else {
    info.status = "Key checking is disabled." as any;
    info.turbo = { activeKeys: Math.min(keys.filter((k) => !k.isDisabled).length, 1) };
    info.gpt4 = {
      activeKeys: Math.min(keys.filter((k) => !k.isDisabled && k.isGpt4).length, 1),
    };
	
	info.gpt4_32k = {
      activeKeys: Math.min(keys.filter((k) => !k.isDisabled && k.isGpt432k).length, 1),
    };
	
	info.gpt4_turbo = {
      activeKeys: Math.min(keys.filter((k) => !k.isDisabled && k.isGpt4Turbo).length, 1),
    };
	
  }

  if (config.queueMode !== "none") {
    const turboQueue = getQueueInformation("turbo");

    info.turbo.proomptersInQueue = turboQueue.proomptersInQueue;
    info.turbo.estimatedQueueTime = turboQueue.estimatedQueueTime;

    if (hasGpt4) {
      const gpt4Queue = getQueueInformation("gpt-4");
      info.gpt4.proomptersInQueue = gpt4Queue.proomptersInQueue;
      info.gpt4.estimatedQueueTime = gpt4Queue.estimatedQueueTime;
    }
	
	if (hasGpt432k) {
      const gpt432kQueue = getQueueInformation("gpt-4-32k");
      info.gpt4_32k.proomptersInQueue = gpt432kQueue.proomptersInQueue;
      info.gpt4_32k.estimatedQueueTime = gpt432kQueue.estimatedQueueTime;
    }
	
	if (hasGpt4Turbo) {
      const gpt4turboQueue = getQueueInformation("gpt-4-turbo");
      info.gpt4_turbo.proomptersInQueue = gpt4turboQueue.proomptersInQueue;
      info.gpt4_turbo.estimatedQueueTime = gpt4turboQueue.estimatedQueueTime;
    }
	
  }

  return info;
}






function getGrokInfo() {
  const info: { [model: string]: Partial<ServiceInfo> } = {};
  const keys = keyPool
    .list()
    .filter((k) => k.service === "grok") as GrokKey[];



  if (config.checkKeys) {
    const grokKeys = keys

    info.grok = {
      activeKeys: Math.min(grokKeys.filter((k) => !k.isDisabled).length, 1),
      revokedKeys: Math.min(grokKeys.filter((k) => k.isRevoked).length, 1),
      overQuotaKeys: Math.min(grokKeys.filter((k) => k.isOverQuota).length, 1),
    };
  } else {
    info.status = "Key checking is disabled." as any;
    info.grok = { activeKeys: Math.min(keys.filter((k) => !k.isDisabled).length, 1)};
  }

  if (config.queueMode !== "none") {
    const grokQueue = getQueueInformation("grok");

    info.grok.proomptersInQueue = grokQueue.proomptersInQueue;
    info.grok.estimatedQueueTime = grokQueue.estimatedQueueTime;
  }

  return info;
}



function getCohereInfo() {
  const info: { [model: string]: Partial<ServiceInfo> } = {};
  const keys = keyPool
    .list()
    .filter((k) => k.service === "cohere") as CohereKey[];



  if (config.checkKeys) {
    const cohereKeys = keys

    info.cohere = {
      activeKeys: Math.min(cohereKeys.filter((k) => !k.isDisabled).length, 1),
      revokedKeys: Math.min(cohereKeys.filter((k) => k.isRevoked).length, 1),
      overQuotaKeys: Math.min(cohereKeys.filter((k) => k.isOverQuota).length, 1),
    };
  } else {
    info.status = "Key checking is disabled." as any;
    info.cohere = { activeKeys: Math.min(keys.filter((k) => !k.isDisabled).length, 1)};
  }

  if (config.queueMode !== "none") {
    const cohereQueue = getQueueInformation("cohere");

    info.cohere.proomptersInQueue = cohereQueue.proomptersInQueue;
    info.cohere.estimatedQueueTime = cohereQueue.estimatedQueueTime;
  }

  return info;
}









function getAnthropicInfo() {
  const claudeInfo: Partial<ServiceInfo> = {};
  const keys = keyPool.list().filter((k) => k.service === "anthropic");
  claudeInfo.activeKeys = Math.min(keys.filter((k) => !k.isDisabled && !k.isRevoked).length, 1);
  claudeInfo.revokedKeys = Math.min(keys.filter((k) => k.isRevoked).length, 1);
  claudeInfo.disabledKeys = Math.min(keys.filter((k) => k.isDisabled).length, 1);
  if (config.queueMode !== "none") {
    const queue = getQueueInformation("claude");
    claudeInfo.proomptersInQueue = queue.proomptersInQueue;
    claudeInfo.estimatedQueueTime = queue.estimatedQueueTime;
  }
  return { claude: claudeInfo };
}


/**
 * If the server operator provides a `greeting.md` file, it will be included in
 * the rendered info page.
 **/
function buildInfoPageHeader(converter: showdown.Converter, title: string) {
  const customGreeting = fs.existsSync("greeting.md")
    ? fs.readFileSync("greeting.md", "utf8")
    : null;

  // TODO: use some templating engine instead of this mess

  let infoBody = `<!-- Header for Showdown's parser, don't remove this line -->
# ${title}`;

  if (config.queueMode !== "none") {
    const waits: string[] = [];
    infoBody += `\n## Estimated Wait Times\nIf the AI is busy, your prompt will processed when a slot frees up.`;

    if (config.openaiKey) {
      const turboWait = getQueueInformation("turbo").estimatedQueueTime;
      const gpt4Wait = getQueueInformation("gpt-4").estimatedQueueTime;
	  const gpt432kWait = getQueueInformation("gpt-4-32k").estimatedQueueTime;
	  const ai21Wait = getQueueInformation("ai21").estimatedQueueTime;
	  
	  const googleWaitExp = getQueueInformation("google-exp").estimatedQueueTime;
      const googleWait15 = getQueueInformation("google-15").estimatedQueueTime;
      const googleWaitFlash = getQueueInformation("google-flash").estimatedQueueTime;
	  const googleWait20Flash = getQueueInformation("google-20-flash").estimatedQueueTime;
	  const googleWaitThinking = getQueueInformation("google-thinking").estimatedQueueTime;
	  
	  const grokWait = getQueueInformation("grok").estimatedQueueTime;
	  const mistralWait = getQueueInformation("mistral").estimatedQueueTime;
	  
	  
      waits.push(`**Turbo:** ${turboWait}`);
      if (keyPool.list().some((k) => k.isGpt4) && !config.turboOnly) {
        waits.push(`**GPT-4:** ${gpt4Wait}`);
      }
	  if (keyPool.list().some((k) => k.isGpt432k) && !config.turboOnly) {
        waits.push(`**GPT-4_32k:** ${gpt432kWait}`);
      }
	  if (keyPool.list().some((k) => k.service == "google")) {
        waits.push(`**GOOGLE EXP:** ${googleWaitExp}`);
        waits.push(`**GOOGLE 1.5:** ${googleWait15}`);
        waits.push(`**GOOGLE FLASH:** ${googleWaitFlash}`);
      }
	  if (keyPool.list().some((k) => k.service == "ai21")) {
        waits.push(`**AI21:** ${ai21Wait}`);
      }
	  
	  if (keyPool.list().some((k) => k.service == "mistral")) {
        waits.push(`**MISTRAL:** ${mistralWait}`);
      }

    if (keyPool.list().some((k) => k.service == "grok")) {
        waits.push(`**Grok:** ${grokWait}`);
      }

	  
    }

    if (config.anthropicKey) {
      const claudeWait = getQueueInformation("claude").estimatedQueueTime;
      waits.push(`**Claude:** ${claudeWait}`);
    }
    infoBody += "\n\n" + waits.join(" / ");
  }

  if (customGreeting) {
    infoBody += `\n## Server Greeting\n
${customGreeting}`;
  }
  return converter.makeHtml(infoBody);
}

/** Returns queue time in seconds, or minutes + seconds if over 60 seconds. */
function getQueueInformation(partition: QueuePartition) {
  if (config.queueMode === "none") {
    return {};
  }
  const waitMs = getEstimatedWaitTime(partition);
  const waitTime =
    waitMs < 60000
      ? `${Math.round(waitMs / 1000)}sec`
      : `${Math.round(waitMs / 60000)}min, ${Math.round(
          (waitMs % 60000) / 1000
        )}sec`;
  return {
    proomptersInQueue: getQueueLength(partition),
    estimatedQueueTime: waitMs > 2000 ? waitTime : "No wait",
  };
}

function getServerTitle() {
  // Use manually set title if available
  if (process.env.SERVER_TITLE) {
    return process.env.SERVER_TITLE;
  }

  // Huggingface
  if (process.env.SPACE_ID) {
    return `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`;
  }

  // Render
  if (process.env.RENDER) {
    return `Render / ${process.env.RENDER_SERVICE_NAME}`;
  }

  return "OAI Reverse Proxy";
}

function getExternalUrlForHuggingfaceSpaceId(spaceId: string) {
  // Huggingface broke their amazon elb config and no longer sends the
  // x-forwarded-host header. This is a workaround.
  try {
    const [username, spacename] = spaceId.split("/");
    return `https://${username}-${spacename.replace(/_/g, "-")}.hf.space`;
  } catch (e) {
    return "";
  }
}
