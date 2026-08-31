/* Minimal request logger (spec §24).
   Logs metadata only — never API keys, auth headers, full user input,
   or full model responses. */

export function createLogger({ logInputPreview = false } = {}) {
  function write(entry) {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
  return {
    request({ requestId, route, provider, model, durationMs, status, errorCode, inputPreview }) {
      const entry = { requestId, route, provider, model, durationMs, status };
      if (errorCode) entry.errorCode = errorCode;
      if (logInputPreview && inputPreview) entry.inputPreview = String(inputPreview).slice(0, 40);
      write(entry);
    }
  };
}
