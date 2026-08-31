/* JSON body reader with hard size limit (spec §23). */

import { Errors } from "../errors/http-error.js";

export function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Errors.payloadTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(Errors.malformedJson());
      }
    });
    req.on("error", () => reject(Errors.malformedJson()));
  });
}
