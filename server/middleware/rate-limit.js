/* Basic per-IP rate limiting (spec §23 — placeholder grade, in-memory).
   Swap for Redis/shared-store when deploying multiple instances. */

import { Errors } from "../errors/http-error.js";

export function createRateLimiter(limitPerMin) {
  const buckets = new Map(); // ip -> { count, resetAt }

  return function checkRateLimit(req) {
    const now = Date.now();
    const ip = req.socket.remoteAddress || "unknown";
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    // periodic cleanup so the map doesn't grow forever
    if (buckets.size > 5000) {
      for (const [key, b] of buckets) if (now > b.resetAt) buckets.delete(key);
    }
    if (bucket.count > limitPerMin) throw Errors.rateLimited();
  };
}
