/* Request ID middleware (spec §13) — every API request gets pk_req_*,
   echoed back in the X-Request-Id header and embedded in error responses. */

let counter = 0;

export function assignRequestId(req, res) {
  counter += 1;
  const id = "pk_req_" + Date.now().toString(36) + counter.toString(36) +
    Math.random().toString(36).slice(2, 6);
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  return id;
}
