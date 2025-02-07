import { GoogleKey, Key } from "../../../key-management";
import { isCompletionRequest } from "../common";
import { ProxyRequestMiddleware } from ".";

/**
 * Some keys require the prompt to start with `\n\nHuman:`. There is no way to
 * know this without trying to send the request and seeing if it fails. If a
 * key is marked as requiring a preamble, it will be added here.
 */
//export const addGooglePreamble: ProxyRequestMiddleware = (
//  _proxyReq,
//  req
//) => {
//  if (!isCompletionRequest(req) || req.key?.service !== "google") {
//    return;
//  }
//
//  let preamble = "";
//  let prompt = req.body.prompt;
//  assertGoogleKey(req.key);
//  if (req.key.requiresPreamble) {
//    preamble = prompt.startsWith("\n\nHuman:") ? "" : "\n\nHuman:";
//    req.log.debug({ key: req.key.hash, preamble }, "Adding preamble to prompt");
//  }
//  req.body.prompt = preamble + prompt;
//};

function assertGoogleKey(key: Key): asserts key is GoogleKey {
  if (key.service !== "google") {
    throw new Error(`Expected an Google key, got '${key.service}'`);
  }
}
