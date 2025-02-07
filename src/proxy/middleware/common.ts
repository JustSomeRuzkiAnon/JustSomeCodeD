import { Request, Response } from "express";
import httpProxy from "http-proxy";
import { ZodError } from "zod";

const OPENAI_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions";
const MISTRAL_CHAT_COMPLETION_ENDPOINT = "/v1/chat/completions"; // not needed at all tbh but will add to make refactor in future more consistent 
const ANTHROPIC_COMPLETION_ENDPOINT = "/v1/messages";
const GOOGLE_COMPLETION_ENDPOINT = "/proxy/google-ai/chat/completions";
const GEMINI_COMPLETION_ENDPOINT = "/proxy/gemini/chat/completions";
const AI21_COMPLETION_ENDPOINT = "/proxy/ai21/chat/completions";


/** Returns true if we're making a request to a completion endpoint. */
export function isCompletionRequest(req: Request) {
  return (
    req.method === "POST" &&
    (req.path === null ||
      [OPENAI_CHAT_COMPLETION_ENDPOINT, ANTHROPIC_COMPLETION_ENDPOINT, GOOGLE_COMPLETION_ENDPOINT, AI21_COMPLETION_ENDPOINT, GEMINI_COMPLETION_ENDPOINT].some(
        (endpoint) => req.path.startsWith(endpoint)
      ))
  );
}

export function writeErrorResponse(
  req: Request,
  res: Response,
  statusCode: number,
  errorPayload: Record<string, any>
) {
  
  const errorSource = errorPayload.error?.type?.startsWith("proxy")
    ? "proxy"
    : "upstream";
  // If we're mid-SSE stream, send a data event with the error payload and end
  // the stream. Otherwise just send a normal error response.
  
  if (
    res.headersSent ||
    res.getHeader("content-type") === "text/event-stream"
  ) {
	
    const errorContent =
      statusCode === 403
        ? JSON.stringify(errorPayload)
        : JSON.stringify(errorPayload, null, 2);

    const msg = buildFakeSseMessage(
      `${errorSource} error (${statusCode})`,
      errorContent,
      req
    );
	if (req.body?.stream === false) {
		if (req.inboundApi == "anthropic") {
			res.write(msg);
			res.write(`data: [DONE]\n\n`);
		} else {
			res.status(statusCode).json({error: {message: errorPayload.message, statusText: errorPayload.message} });
		}
	} else if (req.inboundApi === "anthropic") { // Anthropic like stream
	  res.write('event: message_start\ndata: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-3-5-sonnet-20240620", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 1, "output_tokens": 15}}}\n\n')
	  res.write('event: content_block_start\ndata: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}\n\n');
	  res.write("event: content_block_delta\n"+msg+'\n\n')
	  res.write('event: message_stop\ndata: {"type": "message_stop"}\n\n')
	} else { // Openai like stream 
		res.write(msg);
		res.write(`data: [DONE]\n\n`);
	}
    res.end();
  } else {
    res.status(statusCode).json({error: errorPayload, statusText:"OH NO!"});
  }
}

export const handleProxyError: httpProxy.ErrorCallback = (err, req, res) => {
  req.log.error({ err }, `Error during proxy request middleware`);
  handleInternalError(err, req as Request, res as Response);
};

export const handleInternalError = (
  err: Error,
  req: Request,
  res: Response
) => {
  try {	
    const isZod = err instanceof ZodError;
    const isForbidden = err.name === "ForbiddenError";
    if (isZod) {
      writeErrorResponse(req, res, 400, {
        error: {
          type: "proxy_validation_error",
          proxy_note: `Reverse proxy couldn't validate your request when trying to transform it. Your client may be sending invalid data.`,
          issues: err.issues,
          stack: err.stack,
          message: err.message,
        },
      });
    } else if (isForbidden) {
      // Spoofs a vaguely threatening OpenAI error message. Only invoked by the
      // block-zoomers rewriter to scare off tiktokers.
      writeErrorResponse(req, res, 403, {
        error: {
          type: "organization_account_disabled",
          code: "policy_violation",
          param: null,
          message: err.message,
        },
      });
    } else {
      writeErrorResponse(req, res, 500, {
        error: {
          type: "proxy_internal_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
          stack: err.stack,
        },
      });
    }
  } catch (e) {
    req.log.error(
      { error: {
          type: "proxy_internal_error",
          proxy_note: `Reverse proxy encountered an error before it could reach the upstream API.`,
          message: err.message,
          stack: err.stack,
        }, },
      `Error writing error response headers, giving up.`
    );
  }
};

export function buildFakeSseMessage(
  type: string,
  string: string,
  req: Request
) {
  let fakeEvent;
  const useBackticks = !type.includes("403");
  const msgContent = useBackticks
    ? `\`\`\`\n[${type}: ${string}]\n\`\`\`\n`
    : `[${type}: ${string}]`;

  if (req.inboundApi === "anthropic" && req.body?.stream === true) {
    fakeEvent = {type: "content_block_delta", index: 0, delta: {"type": "text_delta", "text": msgContent, "error": { "code":500, "message": msgContent}}}
  } else {
    fakeEvent = {
      id: "chatcmpl-" + req.id,
      object: "chat.completion.chunk",
      created: Date.now(),
      model: req.body?.model,
      choices: [
        {
          delta: { content: msgContent },
          index: 0,
          finish_reason: type,
        },
      ],
    };
  }
  
  return `data: ${JSON.stringify(fakeEvent)}\n\n`;
}
