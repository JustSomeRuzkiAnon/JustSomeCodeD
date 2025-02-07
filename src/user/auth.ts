import { Request, Response, RequestHandler } from "express";
import { config } from "../config";
import { UserSchema } from "./common"
import { getUsers, getUser } from "../proxy/auth/user-store";
import crypto from "crypto";

const failedAttempts = new Map<string, number>();
const UnauthorizedText = config.responseOnUnauthorized;

type AuthorizeParams = { via: "cookie" | "header" };

export const authorize: ({ via }: AuthorizeParams) => RequestHandler =
  ({ via }) =>
  (req, res, next) => {
    const bearerToken = req.headers.authorization?.slice("Bearer ".length);
    const cookieToken = req.cookies["loginToken"];
    const token = req.cookies.loginToken;
    const attempts = failedAttempts.get(req.ip) ?? 0;

	let userTokens = getUsers().map((item) => item.token)
	
    if (!token) {
      return res.status(401).json({ error: "Unauthorized", statusText: UnauthorizedText });
    }



    if (attempts > 5) {
      req.log.warn(
        { ip: req.ip, token: bearerToken },
        `Blocked user_token request due to too many failed attempts`
      );
      return res.status(401).json({ error: "Too many attempts" });
    }

    if (!userTokens.includes(token)) {
      req.log.warn(
        { ip: req.ip, attempts, token },
        `Attempted User request with invalid token`
      );
      return handleFailedLogin(req, res);
    }

    req.log.info({ ip: req.ip }, `User request authorized`);

	const user = getUser(token);
	if (user) {
		if (user.tokenHash) {
		} else {
			const hash = crypto.createHash("sha256").update(token);
			user.tokenHash = hash.digest("hex");
		}
	}
	

    next();
  };

function handleFailedLogin(req: Request, res: Response) {
  const attempts = failedAttempts.get(req.ip) ?? 0;
  const newAttempts = attempts + 1;
  failedAttempts.set(req.ip, newAttempts);
  if (req.accepts("json", "html") === "json") {
    return res.status(401).json({ error: "Unauthorized", statusText: UnauthorizedText });
  }
  res.clearCookie("loginToken");
  
  
  return res.redirect("/user/login?failed=true");
}

