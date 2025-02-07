import { Router } from "express";

const loginRouter = Router();

loginRouter.get("/login", (req, res) => {
  res.render("user/login", { failed: req.query.failed });
});

loginRouter.post("/login", (req, res) => {

  res.cookie("loginToken", req.body.token, {
    maxAge: 1000 * 60 * 60 * 24 * 14,
    httpOnly: true,
  });
  res.redirect("/user/manage");
});

loginRouter.get("/logout", (req, res) => {
  res.clearCookie("loginToken");
  res.redirect("/user/login");
});

loginRouter.get("/", (req, res) => {
  if (req.cookies["loginToken"]) {
    return res.redirect("/user/manage");
  }
  res.redirect("/user/login");
});

export { loginRouter };
