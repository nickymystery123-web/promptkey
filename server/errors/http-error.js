/* Unified HTTP error — the only error shape the browser ever sees (spec §12).
   Never carries API keys, provider secrets, or stack traces. */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toResponse(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId
      }
    };
  }
}

export function toHttpError(err, requestId) {
  if (err instanceof HttpError) return err;
  return new HttpError(500, "AI_ERROR", "AI service temporarily unavailable.");
}

export const Errors = {
  validation: (msg) => new HttpError(400, "VALIDATION_ERROR", msg),
  malformedJson: () => new HttpError(400, "MALFORMED_JSON", "Request body is not valid JSON."),
  payloadTooLarge: () => new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
  notFound: () => new HttpError(404, "NOT_FOUND", "Resource not found."),
  methodNotAllowed: () => new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed."),
  rateLimited: () => new HttpError(429, "RATE_LIMITED", "Too many requests. Please slow down."),
  providerNotFound: (name) => new HttpError(500, "PROVIDER_NOT_FOUND", `AI provider "${name}" is not registered.`),
  aiError: () => new HttpError(502, "AI_ERROR", "AI service temporarily unavailable."),
  aiBadResponse: () => new HttpError(502, "AI_BAD_RESPONSE", "AI provider returned an unexpected response."),
  aiAuth: (msg) => new HttpError(502, "AI_AUTH_ERROR", msg || "AI provider authentication failed."),
  aiRateLimited: () => new HttpError(502, "AI_RATE_LIMITED", "AI provider rate limit reached. Please try again shortly."),
  aiProviderUnavailable: () => new HttpError(502, "AI_PROVIDER_UNAVAILABLE", "AI provider is temporarily unavailable."),
  aiBadRequest: () => new HttpError(502, "AI_BAD_REQUEST", "AI provider rejected the request."),
  aiTimeout: () => new HttpError(504, "AI_TIMEOUT", "AI request timed out. Please try again."),
  aiAborted: () => new HttpError(499, "AI_ABORTED", "AI request was cancelled.")
};
