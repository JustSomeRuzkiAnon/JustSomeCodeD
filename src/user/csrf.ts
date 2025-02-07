import { doubleCsrf } from "csrf-csrf";
import { v4 as uuid } from "uuid";
import express from "express";

const CSRF_SECRET2 = uuid();

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => CSRF_SECRET2,
  cookieName: "csrf_user",
  cookieOptions: { sameSite: "strict", path: "/" },
  getTokenFromRequest: (req) => req.body["_csrf_user"] || req.query["_csrf_user"],
});

const injectCsrfToken: express.RequestHandler = (req, res, next) => {
  res.locals.csrfTokenUser = generateToken(res, req);
  // force generation of new token on back button
  // TODO: implement session-based CSRF tokens
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
};

export { injectCsrfToken, doubleCsrfProtection as checkCsrfToken };
