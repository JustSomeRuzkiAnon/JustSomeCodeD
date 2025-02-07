/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and json file
 * persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import { v4 as uuid } from "uuid";
import { config } from "../../config";
import { logger } from "../../logger";
import crypto from "crypto";
import { promises as fs } from "fs"

export interface User {
  /** The user's personal access token. */
  token: string;
  tokenHash?: string; 
  alias?: string;
  allowAi21: boolean;
  allowGoogle: boolean;
  allowGpt: boolean;
  allowClaude: boolean;
  
  /** Replacement for prompt/token count **/
  allPromptCount: Record<string, number>; 
  allTokenCountInput: Record<string, number>; 
  allTokenCountOutput: Record<string, number>; 
  
  
  note?: string;
  /** The IP addresses the user has connected from. */
  ip: string[];
  ipPromptCount: Record<string, object>; 
  /** The user's privilege level. */
  type: UserType;
  /** The number of prompts the user has made. */
  promptCount: number;
  
  
  
  /** Prompt Limit for temp user */ 
  promptLimit?: number;
  /** Time Limit for temp user */ 
  endTimeLimit?: number;
  timeLimit?: number;

  /** Rate limit of user_token */
  rateLimit?: number;
  
  /** The time at which the user was created. */
  createdAt: number;
  /** The time at which the user last connected. */
  lastUsedAt?: number;
  /** The time at which the user was disabled, if applicable. */
  disabledAt?: number;
  /** The reason for which the user was disabled, if applicable. */
  disabledReason?: string;
 
}

/**
 * Possible privilege levels for a user.
 * - `normal`: Default role. Subject to usual rate limits and quotas.
 * - `special`: Special role. Higher quotas and exempt from auto-ban/lockout.
 * TODO: implement auto-ban/lockout for normal users when they do naughty shit
 */
export type UserType = "normal" | "special" | "temp";

type UserUpdate = Partial<User> & Pick<User, "token">;

const MAX_IPS_PER_USER = config.maxIpsPerUser;

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();

export async function init() {
  logger.info({ store: config.gatekeeperStore }, "Initializing user store...");
  logger.info("User store initialized.");
  if (config.gatekeeperStore == "json") {
    await initJson();
  }
}

async function initJson() {
  fs.readFile(config.usersJson!, 'utf-8')
    .catch(e => {
      logger.warn(`${config.usersJson!} file not found, starting with no users (${e})`);
    })
    .then(async jsonFile => {
      if (!jsonFile) { return; }

      const parsedUsers: Record<string, any> = JSON.parse(jsonFile);
      for (const user of Object.values(parsedUsers)) {
        upsertUser(user);
      }

      usersToFlush.clear()
    });

  setInterval(updateStore, 20 * 1000);
}

/** Creates a new user and returns their token. */
export function createUser(rLimit: any, pLimit: any) {
  rLimit = parseInt(rLimit)
  const token = uuid();
  users.set(token, {
    token,
	tokenHash: `${crypto.createHash("sha256").update(token).digest("hex")}`,
	alias: "Degenerate",
	note: "Edit",
    ip: [],
	allPromptCount: {},
	allTokenCountInput: {},
	allTokenCountOutput: {},
	ipPromptCount: {},
    type: "normal",
    promptCount: 0,
	rateLimit: parseInt(rLimit),
	promptLimit: parseInt(pLimit),
	allowGpt: true, 
	allowClaude: true, 
	allowGoogle: true, 
	allowAi21: true, 
    createdAt: Date.now(),
  });
  usersToFlush.add(token);
  setImmediate(updateStore); // immediately sync the store
  return token;
}


function generateTempString(): string {
  const userid = uuid().replace(/-/g, '');
  let randomizedUUID = '';
  for (let i = 0; i < userid.length; i++) {
    const char = userid[i];
    const randomCase = Math.random() < 0.5 ? char.toLowerCase() : char.toUpperCase();
    randomizedUUID += randomCase;
  }
  return randomizedUUID;
}
/** Creates a new temp user and returns their token. */
export function createTempUser(pLimit: any, tLimit: any, rLimit: any) {
  const token = "temp-"+generateTempString();
  users.set(token, {
    token,
	alias: "Degenerate",
	allowGpt: true, 
	allowClaude: true, 
	allowGoogle: true, 
	allowAi21: true, 
	allPromptCount: {},
	allTokenCountInput: {},
	allTokenCountOutput: {},
	note: "Edit",
	tokenHash: `${crypto.createHash("sha256").update(token).digest("hex")}`,
    ip: [],
	ipPromptCount: {},
    type: "temp",
    promptCount: 0,
	rateLimit: parseInt(rLimit),
	promptLimit: parseInt(pLimit),
	timeLimit: parseInt(tLimit),
	endTimeLimit: -1,
    createdAt: Date.now(),
  });
  usersToFlush.add(token);
  setImmediate(updateStore); // immediately sync the store
  return token;
}
export function deleteUser(user: User): boolean {
  const token = user.token;

  if (users.has(token)) {
    users.delete(token);
    return true;
  }

  return false;
}


/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}
/** Edits alias of user  */
export function editAlias(token: string, name: string) {
  const user = users.get(token);
  if (!user) return false;
  user.alias = name;
  return true
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user 
  }));
}


const PUBLIC_USERS_TTL = 2500 // TTL of 2.5 seconds make it higher if it's too much
let publicUserJson: any;
let publicUserLastUpdated = 0;

export function handlePublicUsers() {
  if (publicUserLastUpdated + PUBLIC_USERS_TTL > Date.now()) {
    return publicUserJson
  } else {
 cachePublicUsers();
 publicUserLastUpdated = publicUserJson;
 return publicUserLastUpdated
  }
}
function cachePublicUsers() {
    const usersArray = Array.from(users);
    const updatedUsersArray = usersArray.map((user, index) => {
    const updatedUser = {
    createdAt: user[1].createdAt,
    lastUsedAt: user[1].lastUsedAt,
    token: user[1].tokenHash,
    allowAi21: user[1].allowAi21,
    allowClaude: user[1].allowClaude,
    allowGpt: user[1].allowGpt,
    allowGoogle: user[1].allowGoogle,
    allPromptCount: user[1].allPromptCount,
    allTokenCountInput: user[1].allTokenCountInput,
    allTokenCountOutput: user[1].allTokenCountOutput,
	
    
    type: user[1].type,
    promptLimit: user[1].promptLimit,
    timeLimit: user[1].timeLimit,
    endTimeLimit: user[1].endTimeLimit,
    alias: user[1].alias,
    promptCount: user[1].promptCount,
	ips: user[1].ip,
	ipPromptCount: user[1].ipPromptCount
    };
    // Remove hidden ones (Make them Hidden before to make sure everything is fine, doesn't leak any sensitive information)
    return updatedUser;
      });
    publicUserJson = updatedUsersArray;
    return
}

export function getPublicUsers() {
  try {
 return handlePublicUsers();
  } catch (error) {
    return "{'error':'An error occurred while retrieving public users'}"
  }
}


export function updateToken(user: User, newToken: string) {
  users.delete(user.token);
  const updatedUser: User = {
    ...user,
    token: newToken,
  };
  users.set(newToken, updatedUser);
  usersToFlush.add(newToken);
  setImmediate(updateStore); // immediately sync the store
  return updatedUser;
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * user information via JSON. Use other functions for more specific operations.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
	alias: "Degenerate",
	allowAi21: true, 
	allowClaude: true,
	allowGpt: true,
	allowGoogle: true,
	allPromptCount: {},
	allTokenCountInput: {},
	allTokenCountOutput: {},
	note: "Edit",
    ip: [],
    type: "normal",
    promptCount: 0,
	ipPromptCount: {},
	promptLimit: -1,
    createdAt: Date.now(),
  };

  if (!user.tokenHash) {
    user.tokenHash = crypto.createHash("sha256").update(user.token).digest("hex");
  }

  users.set(user.token, {
    ...existing,
    ...user,
  });
  usersToFlush.add(user.token);
  setImmediate(updateStore); // immediately sync the store

  return users.get(user.token);
}



/** Increments the prompt count for the given user. */


export function incrementPromptCount(token: string, model: string, user_ip: string, model_provider: string) {
  const user = users.get(token);
  const oneHourInMillis = 60 * 60 * 1000;
  if (!user) return;
  const user_ip_hash = crypto.createHash('sha256').update(user_ip+config.salt).digest('hex'); 
  const now = Date.now() 
  if (!user.ipPromptCount) {
    user.ipPromptCount = {};
  }

  // Clean up old timestamps if necessary
  const timestamps = Object.keys(user.ipPromptCount); // Array of timestamp strings

  // Remove oldest timestamps if there are more than 25
  if (timestamps.length >= 25) {
    const oldestTimestamp = timestamps.reduce(
      (oldest, current) => Number(current) < Number(oldest) ? current : oldest,
      timestamps[0]
    );
    delete user.ipPromptCount[oldestTimestamp];
  }

  const currentTimestamp = now;
  const recentTimestamp = timestamps.find(
    timestamp => currentTimestamp - Number(timestamp) <= oneHourInMillis
  );

  if (typeof recentTimestamp === 'undefined') {
    // No recent timestamp found within the last hour; create a new one
    const timeStampInfo = {} as { [key: string]: { [key: string]: number } }; // user_ip_hash -> model -> count
    timeStampInfo[user_ip_hash] = {};
    timeStampInfo[user_ip_hash][model] = 1;
    user.ipPromptCount[now.toString()] = timeStampInfo;
  } else {
    // Update existing timestamp entry
    let timeStampInfo = user.ipPromptCount[recentTimestamp] as { [key: string]: { [key: string]: number } };

    // Ensure timeStampInfo is defined
    if (!timeStampInfo) {
      timeStampInfo = {};
    }

    // Check if the IP hash exists
    if (!timeStampInfo[user_ip_hash]) {
      timeStampInfo[user_ip_hash] = {};
    }

    // Check if the model exists under the IP hash
    if (timeStampInfo[user_ip_hash][model]) {
      // Increment the count
      timeStampInfo[user_ip_hash][model] += 1;
    } else {
      // Initialize count for this model at 1
      timeStampInfo[user_ip_hash][model] = 1;
    }

    // Update the timeStampInfo in ipPromptCount
    user.ipPromptCount[recentTimestamp] = timeStampInfo;
  }
  
  if (model_provider == "openai" || model_provider == "grok" || model_provider == "mistral") {
	user.promptCount += 0.5;
  } else if (model_provider == "google" || model_provider == "deepseek" || model_provider == "cohere") {
	user.promptCount += 0.1;
  } else {
	user.promptCount += 1.0;
  }
  
  user.promptCount = Math.round(user.promptCount * 10) / 10;
  
  // New prompt counting 
  const currentValue = user.allPromptCount[model] || 0;
  const incrementedValue = currentValue + 1;
  user.allPromptCount[model] = incrementedValue;

  if(user.type == "temp" && (user.disabledAt ?? false) == false) {
	  if ((user.endTimeLimit ?? 0) == -1 && (user.promptLimit ?? 0) == -1) {
		  user.endTimeLimit = Date.now() + ((user.timeLimit ?? 0)*1000);
		  }

	  if ((user.promptLimit ?? 0) == -1 && Date.now() >= (user.endTimeLimit ?? 0) && (user.timeLimit ?? -1) != -1) {
		  // Deletes token 
		  users.delete(user.token);
	  }
	  
  // Very much requested daily limit ._. here you go...
  } else if (user.type == "normal"  && (user.disabledAt ?? false) == false && (user.promptLimit ?? -1) != -1) {
	  if ((user.endTimeLimit ?? 0) == -1) {
			user.endTimeLimit = Date.now() + (86400 * 1000)
	  }
	  // Reached daily limit
	  if (user.promptCount >= (user.promptLimit ?? 0)) {
		  user.disabledAt = Date.now();
		  user.disabledReason = "dailylimit";
	  }
	  // Reset if person didn't exceed but next day has passed 
	  if (Date.now() >= (user.endTimeLimit ?? 0)) {
		  user.promptCount = 0 
		  user.endTimeLimit = Date.now() + (86400 * 1000)
	  }
  } else if (user.type == "normal"  && (user.disabledReason ?? false) == "dailylimit" && (user.promptLimit ?? -1) != -1 && (user.endTimeLimit ?? 0) != 0) {
	  // Check if daily limit resets
	  if (Date.now() >= (user.endTimeLimit ?? 0)) {
		  user.promptCount = 0 
		  user.endTimeLimit = Date.now() + (86400 * 1000)
	  }
  }
  
  
  usersToFlush.add(token);
}






/** Increments the token count for the given user by the given amount. */
export function incrementTokenCount(token: string, amount = 1, service: string, model: string, outputTokenAmount: number) {
  const user = users.get(token);
  if (!user) return;
    
  // New Token counting 
  const currentInputValue = user.allTokenCountInput[model] || 0;
  const currentOutputValue = user.allTokenCountOutput[model] || 0;
  const incrementedInputValue = currentInputValue + amount;
  const incrementedOutputValue = currentOutputValue + outputTokenAmount;
    
  user.allTokenCountInput[model] = incrementedInputValue;
  user.allTokenCountOutput[model] = incrementedOutputValue;
  
  
  usersToFlush.add(token);
}

// Very very dirty ^^ 
let globalTokenCountOpenai = 0;
let globalTokenCountAnthropic = 0 

export function incrementGlobalTokenCount(amount = 1, model = "") {
  if (model == "openai") {
	  globalTokenCountOpenai+=amount;
  } else if (model == "anthropic") {
	  globalTokenCountAnthropic+=amount;
  }
}

export function getGlobalTokenCount() {
  return globalTokenCountOpenai+globalTokenCountAnthropic;
}
export function getClaudeTokenCount() {
  return globalTokenCountAnthropic;
}
export function getOpenaiTokenCount() {
  return globalTokenCountOpenai;
}


/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(token: string, ip: string) {
  const user = users.get(token);
  if (!user || user.disabledAt) return;
  let ipHash = crypto.createHash('sha256').update(ip+config.salt).digest('hex');
  if (!user.ip.includes(ipHash)) {
	user.ip.push( ipHash );
  };
  
  // If too many IPs are associated with the user, disable the account.
  const ipLimit =
    user.type === "special" || !MAX_IPS_PER_USER ? Infinity : MAX_IPS_PER_USER;
  if (user.ip.length > ipLimit) {
    disableUser(token, "Too many IP addresses associated with this token.");
    return;
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return user;
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  usersToFlush.add(token);
}

async function updateStore() {
  if (usersToFlush.size === 0) {
    return;
  }
  if (config.gatekeeperStore == "json") {
    usersToFlush.clear();
    // any :<
    let usersObject: Record<string, any> = structuredClone(Object.fromEntries(users));
    for (const token in usersObject) {
      if (usersObject[token].ip) {
        delete usersObject[token].ip;
      }
      if (usersObject[token].ipPromptCount) {
        delete usersObject[token].ipPromptCount;
      }
    }
    const jsonFile = JSON.stringify(usersObject);
    await fs.writeFile(config.usersJson!, jsonFile);
  }
}