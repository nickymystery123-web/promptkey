/* Basic CORS (spec §23). Frontend is served same-origin by this server,
   so this mostly guards direct API access from other tools. */

export function applyCors(req, res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return req.method === "OPTIONS"; // true → caller should short-circuit 204
}
