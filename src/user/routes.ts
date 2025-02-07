import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authorize } from "./auth";
import { injectCsrfToken, checkCsrfToken } from "./csrf";
import { usersApiRouter as apiRouter } from "./api/users";
import { usersUiRouter as uiRouter } from "./ui/users";
import { loginRouter } from "./login";


const userRouter = Router();

userRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
userRouter.use(cookieParser());
userRouter.use(injectCsrfToken);

userRouter.use(checkCsrfToken); // All UI routes require CSRF token

userRouter.use("/", loginRouter);
userRouter.use("/manage", authorize({ via: "cookie" }), uiRouter);

export { userRouter };
