import { fixRequestBody } from "http-proxy-middleware";
import type { ProxyRequestMiddleware } from ".";
import { config } from "../../../config";
import crypto from 'crypto';

interface Message {
    role: string;
    content: string; // Add other properties if needed
}

export const finalizeBody: ProxyRequestMiddleware = (proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
	if (req.body.model.includes("claude")) {
		delete req.body["prompt"] // idk why 
	}
	if (req.body.model.startsWith("dall-")) {
		delete req.body["stream"] // idk why 
	}

	
	
	let updatedBody = JSON.stringify(req.body);
	
	
    if (req.body.model.includes("gemini")) {	
		const { stream, ...bodyWithoutStream } = JSON.parse(updatedBody);
		updatedBody = JSON.stringify(bodyWithoutStream);
		const isStream = JSON.parse(req.newRequest.body).stream 
		const version = req.body.model.includes("thinking") ? "v1alpha" : "v1beta"; // Check if model includes "thinking"
		const googleRequestURL = config.googleProxy+`/${version}/models/${req.body.model}:${isStream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
		proxyReq.path = new URL(googleRequestURL).pathname + new URL(googleRequestURL).search;
	}
	
	if (req.key?.isAws) {
		let { model, stream, prompt, ...otherProps } = req.body;
		if (req.outboundApi == "mistral") {
			const key = req.key.key
		} else {
			const key = req.key.key
		}
		const awsSecret = req.key.awsSecret || ""
		const awsRegion = req.key.awsRegion || ""
		
		const requestURL = `/model/${req.body.model}/invoke${stream ? "-with-response-stream" : ""}`;
		req.signedRequest.hostname = requestURL;
		delete req.signedRequest.headers['content-length'];

		proxyReq.getRawHeaderNames().forEach(proxyReq.removeHeader.bind(proxyReq));
		Object.entries(req.signedRequest.headers).forEach(([key, value]) => {
		proxyReq.setHeader(key, value);
	  });
		proxyReq.removeHeader('content-length'); // Remove 'content-length' header
		proxyReq.path = req.signedRequest.path;
		

		proxyReq.write(req.signedRequest.body);
		return 
	} else if (req.key?.key.includes(";") && req.key?.specialMap != undefined) {
		if (req.key?.specialMap != undefined) {
			const deployment = req.key.specialMap[req.body.model];
			const endpoint = req.key.key.split(";")[0]
			const api_key =  req.key.key.split(";")[1]
			

			const requestURL = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-01`;
			req.newRequest.hostname = requestURL;
			proxyReq.path = new URL(requestURL).pathname + new URL(requestURL).search;
			req.headers['Content-Type'] = 'application/json';
			req.headers['api-key'] = api_key;
			req.headers['User-Agent'] = 'OpenAI/v1 PythonBindings/0.28.1';
			
			
			
			proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
			(req as any).rawBody = Buffer.from(updatedBody);
			fixRequestBody(proxyReq, req);
		}  
    } else {
		// Use new max tokens parametr instead of legacy one.
		if (req.body.max_tokens && (req.body.model.startsWith("gpt") || req.body.model.includes("chatgpt") || req.body.model.includes("o1") || req.body.model.includes("o3")) ) {
			const { max_tokens, ...bodyWithoutMax_tokens } = JSON.parse(updatedBody);
			req.body.max_completion_tokens = max_tokens 
			delete req.body["max_tokens"]
			updatedBody = JSON.stringify(bodyWithoutMax_tokens);
		}
		
		if (req.body.model.startsWith("dall-")){
			if (req.body.response_format == "url") {
				req.body.response_format = "b64_json"
			}
			
			proxyReq.path = "/v1/images/generations"
		}
		
		if (req.body.model.startsWith("o1-") || req.body.model.startsWith("o3-")){
			const { max_tokens, ...bodyWithoutMax_tokens } = JSON.parse(updatedBody);
			updatedBody = JSON.stringify(bodyWithoutMax_tokens);
			
			// system > assistant 
			//req.body.messages.forEach((message: Message) => {
			//	if (message.role === 'system') {
			//		message.role = 'assistant';
			//	}
			//});
			
			
		}
		
			
			
		proxyReq.setHeader("Content-Length", Buffer.byteLength(updatedBody));
		
		(req as any).rawBody = Buffer.from(updatedBody);
		fixRequestBody(proxyReq, req);
	}
  }
};


