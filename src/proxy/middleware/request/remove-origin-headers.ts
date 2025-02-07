import { ProxyRequestMiddleware } from ".";

/**
 * Removes origin and referer headers before sending the request to the API for
 * privacy reasons.
 **/
export const removeOriginHeaders: ProxyRequestMiddleware = (proxyReq) => {
  proxyReq.setHeader("origin", "");
  proxyReq.setHeader("referer", "");

  proxyReq.removeHeader("cf-connecting-ip");
  proxyReq.removeHeader("forwarded");
  proxyReq.removeHeader("true-client-ip");
  proxyReq.removeHeader("x-forwarded-for");
  proxyReq.removeHeader("x-real-ip");
};
