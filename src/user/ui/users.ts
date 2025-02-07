import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import { getUser, editAlias } from "../../proxy/auth/user-store";

import {
  UserSchemaWithToken,
  parseSort, parseHide, 
  sortBy,
  paginate,
  UserSchema,
} from "../common";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/json") {
      cb(new Error("Invalid file type"));
    } else {
      cb(null, true);
    }
  },
});

router.get("/", (_req, res) => {
  res.render("user/index", {
	user: getUser(_req.cookies.loginToken)
  });
});


function validateAlias(username: string): boolean {
  const pattern = /^[\w\s]{1,16}$/;
  return pattern.test(username);
}

router.post("/change-alias", (req, res) => {
  const newName = req.body.name;
  const token = req.cookies.loginToken;
  
  if (validateAlias(newName)) {
    editAlias(token, newName)
	res.redirect(`/user/manage?changedTo=`+newName);
  } else {
	res.redirect(`/user/manage?notValid=`+newName);
  }
  
});




export { router as usersUiRouter };
