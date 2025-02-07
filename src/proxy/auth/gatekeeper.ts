import type { Request, RequestHandler } from "express";
import { config } from "../../config";
import { authenticate, getUser } from "./user-store";

const GATEKEEPER = config.gatekeeper;
const ADMIN_KEY = config.adminKey;

interface ExtendedRequest extends Request {
  _parsedUrl?: {
    pathname?: string;
    search?: string | null;
    query?: string | null;
    path?: string;
    href?: string;
    _raw?: string;
  };
}

function getProxyAuthorizationFromRequest(req: ExtendedRequest): string | undefined {
  // Anthropic's API uses x-api-key instead of Authorization.  Some clients will
  // pass the _proxy_ key in this header too, instead of providing it as a
  // Bearer token in the Authorization header.  So we need to check both.
  // Prefer the Authorization header if both are present.
  

  if (req.headers.authorization) {
    const token = req.headers.authorization?.slice("Bearer ".length);
    delete req.headers.authorization;
    return token;
  }

  if (req.headers["x-api-key"]) {
    const token = req.headers["x-api-key"]?.toString();
    delete req.headers["x-api-key"];
    return token;
  }
  
  // Wowie google auth :o :O such smart.... i love google! google everything! ._. 
  if (req.query.key) {
	const token = req.query.key?.toString()
	delete req.query.key

	// Strip queries ._. lalala i will kill someone :3c google google... 
	req.url = req.url.split('?')[0];
	req.baseUrl = req.baseUrl.split('?')[0];
	req.originalUrl = req.originalUrl.split('?')[0];
	
	
	if (req._parsedUrl && req._parsedUrl.search) {
		req._parsedUrl.search = null;
		req._parsedUrl.query = null;
		req._parsedUrl.path = req._parsedUrl.pathname;
		req._parsedUrl.href = req._parsedUrl.pathname;
		req._parsedUrl._raw = req._parsedUrl.pathname;
	  }

	return token 
  }

  return undefined;
}

export const gatekeeper: RequestHandler = (req, res, next) => {
  
  const token = getProxyAuthorizationFromRequest(req);

  if (ADMIN_KEY && token === ADMIN_KEY) {
    return next();
  }

  if (GATEKEEPER === "none") {
    return next();
  }

  if (GATEKEEPER === "proxy_key" && token === config.proxyKey) {
    return next();
  }

  if (GATEKEEPER === "user_token" && token) {
    const user = authenticate(token, req.ip);
    if (user) {
      req.user = user;
      return next();
    } else {
      const maybeBannedUser = getUser(token);
      if (maybeBannedUser?.disabledAt) {
        return res.status(403).json({
          error: `Forbidden: ${
            maybeBannedUser.disabledReason || "Token disabled"
          }`,
        });
      }
    }
  }
  
  // i don't think it's my fault that custom error message isn't passed in ST.
  res.status(403).json({ error: { message: config.responseOnUnauthorized } });
};
 