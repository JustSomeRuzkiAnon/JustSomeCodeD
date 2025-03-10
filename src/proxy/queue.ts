/**
 * Very scuffed request queue. OpenAI's GPT-4 keys have a very strict rate limit
 * of 40000 generated tokens per minute. We don't actually know how many tokens
 * a given key has generated, so our queue will simply retry requests that fail
 * with a non-billing related 429 over and over again until they succeed.
 *
 * Dequeueing can operate in one of two modes:
 * - 'fair': requests are dequeued in the order they were enqueued.
 * - 'random': requests are dequeued randomly, not really a queue at all.
 *
 * When a request to a proxied endpoint is received, we create a closure around
 * the call to http-proxy-middleware and attach it to the request. This allows
 * us to pause the request until we have a key available. Further, if the
 * proxied request encounters a retryable error, we can simply put the request
 * back in the queue and it will be retried later using the same closure.
 */

import crypto from "crypto";
import type { Handler, Request } from "express";
import { keyPool, SupportedModel } from "../key-management";
import { logger } from "../logger";
import { AGNAI_DOT_CHAT_IP, getUniqueIps } from "./rate-limit";
import { RequestPreprocessor } from "./middleware/request";
import { init } from "../tokenization";
import { buildFakeSseMessage } from "./middleware/common";


export type QueuePartition = "claude" | "turbo" | "gpt-4" | "gpt-4-32k" | "gpt-o" | "gpt-4-turbo" | "google-exp" | "google-15" | "google-flash" | "google-20-flash" | "google-20-pro" | "google-flash-lite" | "google-thinking" | "ai21" | "grok" | "mistral" | "deepseek" | "cohere" | "together";

const queue: Request[] = [];
const log = logger.child({ module: "request-queue" });

/** Maximum number of queue slots for Agnai.chat requests. */
const AGNAI_CONCURRENCY_LIMIT = 5;
/** Maximum number of queue slots for individual users. */
const USER_CONCURRENCY_LIMIT = 1;

const MIN_HEARTBEAT_SIZE = 512;
const MAX_HEARTBEAT_SIZE =
  1024 * parseInt(process.env.MAX_HEARTBEAT_SIZE_KB ?? "1024");
const HEARTBEAT_INTERVAL =
  1000 * parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? "5");
const LOAD_THRESHOLD = parseFloat(process.env.LOAD_THRESHOLD ?? "50");
const PAYLOAD_SCALE_FACTOR = parseFloat(
  process.env.PAYLOAD_SCALE_FACTOR ?? "6"
);


const SHARED_IP_ADDRESSES = new Set([
  // Agnai.chat
  "157.230.249.32", // old
  "157.245.148.56",
  "174.138.29.50",
  "209.97.162.44",
]);

const isFromSharedIp = (req: Request) => SHARED_IP_ADDRESSES.has(req.ip);

/**
 * Returns a unique identifier for a request. This is used to determine if a
 * request is already in the queue.
 * This can be (in order of preference):
 * - user token assigned by the proxy operator
 * - x-risu-tk header, if the request is from RisuAI.xyz
 * - IP address
 */
 

function getIdentifier(req: Request) {
  if (req.user) return req.user.token;
  if (req.risuToken) return req.risuToken;
  if (isFromSharedIp(req)) return "shared-ip";
  return req.ip;
}


const sameUserPredicate = (incoming: Request) => (queued: Request) => {
  const queuedId = getIdentifier(queued);
  const incomingId = getIdentifier(incoming);
  return queuedId === incomingId;
};



export function enqueue(req: Request) {
  const enqueuedRequestCount = queue.filter(sameUserPredicate(req)).length;
  let isGuest = req.user?.token === undefined;
  
  

  // All Agnai.chat requests come from the same IP, so we allow them to have
  // more spots in the queue. Can't make it unlimited because people will
  // intentionally abuse it.
  // Authenticated users always get a single spot in the queue.
  const isSharedIp = isFromSharedIp(req);
  const maxConcurrentQueuedRequests =
    isGuest && isSharedIp ? AGNAI_CONCURRENCY_LIMIT : USER_CONCURRENCY_LIMIT;
  if (enqueuedRequestCount >= maxConcurrentQueuedRequests) {
    if (isSharedIp) {
      // Re-enqueued requests are not counted towards the limit since they
      // already made it through the queue once.
      if (req.retryCount === 0) {
        throw new Error("Too many agnai.chat requests are already queued");
      }
    } else {
      throw new Error("Your IP or token already has a request in the queue");
    }
  }

  if(req.user?.type == "temp" && (req.user.disabledAt ?? false) == false) { 
    if ((req.user.promptLimit ?? 0) != -1 && req.user.promptCount >= (req.user.promptLimit ?? 0)) {
      throw new Error("No prompts left on the key.");
    }
  }

  // shitty hack to remove hpm's event listeners on retried requests
  removeProxyMiddlewareEventListeners(req);

  // If the request opted into streaming, we need to register a heartbeat
  // handler to keep the connection alive while it waits in the queue. We
  // deregister the handler when the request is dequeued.
  if (req.body.stream === "true" || req.body.stream === true) {
    const res = req.res!;

    if (!res.headersSent) {
      initStreaming(req);
    }
    registerHeartbeat(req);
  } else if (getProxyLoad() > LOAD_THRESHOLD) {
    throw new Error(
      "Due to heavy traffic on this proxy, you must enable streaming for your request."
    );
  } else {
    req.body.stream = false
  }

  queue.push(req);
  req.queueOutTime = 0;

  const removeFromQueue = () => {
    req.log.info(`Removing aborted request from queue.`);
    const index = queue.indexOf(req);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (req.heartbeatInterval) clearInterval(req.heartbeatInterval);
    if (req.monitorInterval) clearInterval(req.monitorInterval);
  };
  req.onAborted = removeFromQueue;
  req.res!.once("close", removeFromQueue);

  if (req.retryCount ?? 0 > 0) {
    req.log.info({ retries: req.retryCount }, `Enqueued request for retry.`);
  } else {
    req.log.info(`Enqueued new request.`);
  }
}

function getPartitionForRequest(req: Request): QueuePartition {
  // There is a single request queue, but it is partitioned by model and API
  // provider.
  // - claude: requests for the Anthropic API, regardless of model
  // - gpt-4: requests for the OpenAI API, specifically for GPT-4 models
  // - turbo: effectively, all other requests
  const provider = req.outboundApi;
  const model = (req.body.model as SupportedModel) ?? "gpt-3.5-turbo";
  
  if (provider === "openai" && model.startsWith("o1-")) {
    return "gpt-o";
  }
  if (provider === "openai" && model.startsWith("o3-")) {
    return "gpt-o";
  }
  if (provider === "openai" && model.startsWith("gpt-4-32k")) {
    return "gpt-4-32k";
  }
  if (provider === "anthropic") {
    return "claude";
  }
  if (provider === "openai" && (model.startsWith("gpt-4") || model.startsWith("chatgpt"))) {
    return "gpt-4";
  }
  
  

  if (provider === "openai" && model.includes("2.0-pro")) {
    return "google-20-pro";
  }

  if (provider === "openai" && model.includes("flash-lite")) {
    return "google-flash-lite";
  }

  if (provider === "openai" && model.includes("2.0-flash")) {
    return "google-20-flash";
  }

  if (provider === "openai" && model.includes("flash")) {
    return "google-flash";
  }

  if (provider === "openai" && model.includes("2.0-flash-thinking")) {
    return "google-thinking";
  }

  if (provider === "openai" && (model.includes("exp") || model.startsWith("learnlm"))) {
    return "google-exp";
  }



  if (provider === "google") {
    if (model.includes("1.5")) {
      return "google-15";
    }
    if (model.includes("exp")) {
      return "google-exp";
    }
    if (model.includes("2.0-pro")) {
      return "google-20-pro";
    }
    if (model.includes("2.0-flash")) {
      return "google-20-flash";
    }
    if (model.includes("flash-lite")) {
      return "google-flash-lite";
    }
    if (model.includes("flash")) {
      return "google-flash";
    }
    if (model.includes("2.0-flash-thinking")) {
      return "google-thinking";
    }


  }


  
  if (provider === "grok") {
    return "grok";
  }
  
  if (provider === "deepseek") {
    return "deepseek";
  }
  
  if (provider === "cohere") {
    return "cohere";
  }
  
  if (provider === "together") {
    return "together";
  }
  
  if (provider === "mistral" || model.startsWith("mistral")) {
    return "mistral";
  }
  
  
  return "turbo";
}

function getQueueForPartition(partition: QueuePartition): Request[] {
	
  return queue.filter((req) => getPartitionForRequest(req) === partition);
}

export function dequeue(partition: QueuePartition): Request | undefined {
  const modelQueue = getQueueForPartition(partition);

  if (modelQueue.length === 0) {
    return undefined;
  }

  const req = modelQueue.reduce((prev, curr) =>
    prev.startTime < curr.startTime ? prev : curr
  );
  queue.splice(queue.indexOf(req), 1);

  if (req.onAborted) {
    req.res!.off("close", req.onAborted);
    req.onAborted = undefined;
  }

  if (req.heartbeatInterval) clearInterval(req.heartbeatInterval);
  if (req.monitorInterval) clearInterval(req.monitorInterval);

  // Track the time leaving the queue now, but don't add it to the wait times
  // yet because we don't know if the request will succeed or fail. We track
  // the time now and not after the request succeeds because we don't want to
  // include the model processing time.
  req.queueOutTime = Date.now();
  return req;
}

/**
 * Naive way to keep the queue moving by continuously dequeuing requests. Not
 * ideal because it limits throughput but we probably won't have enough traffic
 * or keys for this to be a problem.  If it does we can dequeue multiple
 * per tick.
 **/
function processQueue() {
  // This isn't completely correct, because a key can service multiple models.
  // Currently if a key is locked out on one model it will also stop servicing
  // the others, because we only track one rate limit per key.
  const gpt4Lockout = keyPool.getLockoutPeriod("gpt-4");
  const gpt432kLockout = keyPool.getLockoutPeriod("gpt-4-32k");
  const gptOLockout = keyPool.getLockoutPeriod("gpt-o");
  
  const gpt4turboLockout = keyPool.getLockoutPeriod("gpt-4-32k");
  const turboLockout = keyPool.getLockoutPeriod("gpt-3.5-turbo");
  const claudeLockout = keyPool.getLockoutPeriod("claude-v1.0");
  const grokLockout = keyPool.getLockoutPeriod("grok-2-1212");
  const mistralLockout = keyPool.getLockoutPeriod("mistral-large-latest");


  const google20ProLockout = keyPool.getLockoutPeriod("gemini-2.0-pro-exp");
  const googleThinkingLockout = keyPool.getLockoutPeriod("gemini-2.0-flash-thinking-exp");
  const googleExpLockout = google20ProLockout;
  const google15Lockout = keyPool.getLockoutPeriod("gemini-1.5-pro");
  const googleFlashLockout = keyPool.getLockoutPeriod("gemini-1.5-flash");
  const google20FlashLockout = keyPool.getLockoutPeriod("gemini-2.0-flash");
  const google20FlashLiteLockout = keyPool.getLockoutPeriod("gemini-1.5-flash");
  const deepseekLockout = keyPool.getLockoutPeriod("deepseek-chat");
  const cohereLockout = keyPool.getLockoutPeriod("command-light");
  const togetherLockout = keyPool.getLockoutPeriod("google/gemma-2b-it");


  const reqs: (Request | undefined)[] = [];
  if (google20FlashLockout === 0) {
    reqs.push(dequeue("google-20-flash"));
  }
  if (google20FlashLiteLockout === 0) {
    reqs.push(dequeue("google-flash-lite"));
  }
  if (google20ProLockout === 0) {
    reqs.push(dequeue("google-20-pro"));
  }
  if (googleThinkingLockout === 0) {
    reqs.push(dequeue("google-thinking"));
  }
  if (googleExpLockout === 0) {
    reqs.push(dequeue("google-exp"));
  }
  if (google15Lockout === 0) {
    reqs.push(dequeue("google-15"));
  }
  if (googleFlashLockout === 0) {
    reqs.push(dequeue("google-flash"));
  }
  if (gptOLockout === 0) {
    reqs.push(dequeue("gpt-o"));
  }
  if (gpt4Lockout === 0) {
    reqs.push(dequeue("gpt-4"));
  }
  if (gpt432kLockout === 0) {
    reqs.push(dequeue("gpt-4-32k"));
  }
  if (gpt4turboLockout === 0) {
    reqs.push(dequeue("gpt-4-turbo"));
  }
  if (turboLockout === 0) {
    reqs.push(dequeue("turbo"));
  }
  if (claudeLockout === 0) {
    reqs.push(dequeue("claude"));
  }
  
  if (grokLockout === 0) {
    reqs.push(dequeue("grok"));
  }
  
  if (mistralLockout === 0) {
    reqs.push(dequeue("mistral"));
  }
  
  if (deepseekLockout === 0) {
    reqs.push(dequeue("deepseek"));
  }
  
  if (cohereLockout === 0) {
    reqs.push(dequeue("cohere"));
  }
  
  if (togetherLockout === 0) {
    reqs.push(dequeue("together"));
  }

  reqs.filter(Boolean).forEach((req) => {
    if (req?.proceed) {
      req.log.info({ retries: req.retryCount }, `Dequeuing request.`);
      req.proceed();
    }
  });
  setTimeout(processQueue, 50);
}

/**
 * Kill stalled requests after 5 minutes, and remove tracked wait times after 2
 * minutes.
 **/
function cleanQueue() {
  const now = Date.now();
  const oldRequests = queue.filter(
    (req) => now - (req.startTime ?? now) > 5 * 60 * 1000
  );
  oldRequests.forEach((req) => {
    req.log.info(`Removing request from queue after 5 minutes.`);
    killQueuedRequest(req);
  });

  const index = waitTimes.findIndex(
    (waitTime) => now - waitTime.end > 300 * 1000
  );
  const removed = waitTimes.splice(0, index + 1);
  log.trace(
    { stalledRequests: oldRequests.length, prunedWaitTimes: removed.length },
    `Cleaning up request queue.`
  );
  setTimeout(cleanQueue, 20 * 1000);
}

export function start() {
  // initialize both tokenizers
  init();
  log.info(`Started tokenizers.`);

  processQueue();
  cleanQueue();
  log.info(`Started request queue.`);
}

let waitTimes: { partition: QueuePartition; start: number; end: number }[] = [];

/** Adds a successful request to the list of wait times. */
export function trackWaitTime(req: Request) {
  waitTimes.push({
    partition: getPartitionForRequest(req),
    start: req.startTime!,
    end: req.queueOutTime ?? Date.now(),
  });
}

/** Returns average wait time in milliseconds. */
export function getEstimatedWaitTime(partition: QueuePartition) {
  const now = Date.now();
  const recentWaits = waitTimes.filter(
    (wt) => wt.partition === partition && now - wt.end < 300 * 1000
  );
  if (recentWaits.length === 0) {
    return 0;
  }

  return (
    recentWaits.reduce((sum, wt) => sum + wt.end - wt.start, 0) /
    recentWaits.length
  );
}

export function getQueueLength(partition: QueuePartition | "all" = "all") {
  if (partition === "all") {
    return queue.length;
  }
  const modelQueue = getQueueForPartition(partition);
  return modelQueue.length;
}

export function createQueueMiddleware({
  beforeProxy,
  proxyMiddleware,
}: {
  beforeProxy?: RequestPreprocessor;
  proxyMiddleware: Handler;
}): Handler {
  return (req, res, next) => {
    req.proceed = async () => {
      if (beforeProxy) {
        // Hack to let us run asynchronous middleware before the
        // http-proxy-middleware handler. This is used to sign AWS requests
        // before they are proxied, as the signing is asynchronous.
        // Unlike RequestPreprocessors, this runs every time the request is
        // dequeued, not just the first time.
        await beforeProxy(req, res);
      }
      proxyMiddleware(req, res, next);
    };

    try {
      enqueue(req);
    } catch (err: any) {
      req.res!.status(429).json({
        type: "proxy_error",
        message: err.message,
        stack: err.stack,
        proxy_note: `Only one request can be queued at a time. If you don't have another request queued, your IP or user token might be in use by another request.`,
      });
    }
  };
}

function killQueuedRequest(req: Request) {
  if (!req.res || req.res.writableEnded) {
    req.log.warn(`Attempted to terminate request that has already ended.`);
    queue.splice(queue.indexOf(req), 1);
    return;
  }
  const res = req.res;
  try {
    const message = `Your request has been terminated by the proxy because it has been in the queue for more than 5 minutes. The queue is currently ${queue.length} requests long.`;
    if (res.headersSent) {
      const fakeErrorEvent = buildFakeSseMessage(
        "proxy queue error",
        message,
        req
      );
      res.write(fakeErrorEvent);
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  } catch (e) {
    req.log.error(e, `Error killing stalled request.`);
  }
}

function initStreaming(req: Request) {
  req.log.info(`Initiating streaming for new queued request.`);
  const res = req.res!;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx-specific fix
  res.flushHeaders();
  res.write("\n");
  res.write(": joining queue\n\n");
  res.write(getHeartbeatPayload());
}

/**
 * http-proxy-middleware attaches a bunch of event listeners to the req and
 * res objects which causes problems with our approach to re-enqueuing failed
 * proxied requests. This function removes those event listeners.
 * We don't have references to the original event listeners, so we have to
 * look through the list and remove HPM's listeners by looking for particular
 * strings in the listener functions. This is an astoundingly shitty way to do
 * this, but it's the best I can come up with.
 */
function removeProxyMiddlewareEventListeners(req: Request) {
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:29
  // res.listeners('close')
  const RES_ONCLOSE = `Destroying proxyRes in proxyRes close event`;
  // node_modules/http-proxy-middleware/dist/plugins/default/debug-proxy-errors-plugin.js:19
  // res.listeners('error')
  const RES_ONERROR = `Socket error in proxyReq event`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:146
  // req.listeners('aborted')
  const REQ_ONABORTED = `proxyReq.abort()`;
  // node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:156
  // req.listeners('error')
  const REQ_ONERROR = `if (req.socket.destroyed`;

  const res = req.res!;

  const resOnClose = res
    .listeners("close")
    .find((listener) => listener.toString().includes(RES_ONCLOSE));
  if (resOnClose) {
    res.removeListener("close", resOnClose as any);
  }

  const resOnError = res
    .listeners("error")
    .find((listener) => listener.toString().includes(RES_ONERROR));
  if (resOnError) {
    res.removeListener("error", resOnError as any);
  }

  const reqOnAborted = req
    .listeners("aborted")
    .find((listener) => listener.toString().includes(REQ_ONABORTED));
  if (reqOnAborted) {
    req.removeListener("aborted", reqOnAborted as any);
  }

  const reqOnError = req
    .listeners("error")
    .find((listener) => listener.toString().includes(REQ_ONERROR));
  if (reqOnError) {
    req.removeListener("error", reqOnError as any);
  }
}

export function registerHeartbeat(req: Request) {
  const res = req.res!;

  let isBufferFull = false;
  let bufferFullCount = 0;
  req.heartbeatInterval = setInterval(() => {
    if (isBufferFull) {
      bufferFullCount++;
      if (bufferFullCount >= 3) {
        req.log.error("Heartbeat skipped too many times; killing connection.");
        res.destroy();
      } else {
        req.log.warn({ bufferFullCount }, "Heartbeat skipped; buffer is full.");
      }
      return;
    }

    const data = getHeartbeatPayload();
    if (!res.write(data)) {
      isBufferFull = true;
      res.once("drain", () => (isBufferFull = false));
    }
  }, HEARTBEAT_INTERVAL);
  monitorHeartbeat(req);
}

function monitorHeartbeat(req: Request) {
  const res = req.res!;

  let lastBytesSent = 0;
  req.monitorInterval = setInterval(() => {
    const bytesSent = res.socket?.bytesWritten ?? 0;
    const bytesSinceLast = bytesSent - lastBytesSent;
    req.log.debug(
      {
        previousBytesSent: lastBytesSent,
        currentBytesSent: bytesSent,
      },
      "Heartbeat monitor check."
    );
    lastBytesSent = bytesSent;

    const minBytes = Math.floor(getHeartbeatSize() / 2);
    if (bytesSinceLast < minBytes) {
      req.log.warn(
        { minBytes, bytesSinceLast },
        "Queued request is processing heartbeats enough data or server is overloaded; killing connection."
      );
      res.destroy();
    }
  }, HEARTBEAT_INTERVAL * 2);
}

/** Sends larger heartbeats when the queue is overloaded */
function getHeartbeatSize() {
  const load = getProxyLoad();

  if (load <= LOAD_THRESHOLD) {
    return MIN_HEARTBEAT_SIZE;
  } else {
    const excessLoad = load - LOAD_THRESHOLD;
    const size =
      MIN_HEARTBEAT_SIZE + Math.pow(excessLoad * PAYLOAD_SCALE_FACTOR, 2);
    if (size > MAX_HEARTBEAT_SIZE) return MAX_HEARTBEAT_SIZE;
    return size;
  }
}

function getHeartbeatPayload() {
  const size = getHeartbeatSize();
  const data =
    process.env.NODE_ENV === "production"
      ? crypto.randomBytes(size)
      : `payload size: ${size}`;
  return `: queue heartbeat ${data}\n\n`;
}

function getProxyLoad() {
  return Math.max(getUniqueIps(), queue.length);
}
