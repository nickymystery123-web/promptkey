/* HttpAIService — AIService implementation that talks to the backend API.
   The prompt flow sees only the AIService interface; it knows nothing about
   providers, models, or keys (those live server-side). */

const NETWORK_ERROR = "NETWORK_ERROR";

async function post(fetchImpl, baseUrl, path, body, signal) {
  let res;
  try {
    res = await fetchImpl(baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw Object.assign(new Error("Request aborted"), { code: "AI_ABORTED" });
    }
    throw Object.assign(new Error("Backend unreachable"), { code: NETWORK_ERROR });
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON (e.g. static host 404) */ }

  if (!res.ok) {
    const code = data && data.error && data.error.code ? data.error.code : NETWORK_ERROR;
    const message = data && data.error && data.error.message ? data.error.message : "AI request failed.";
    throw Object.assign(new Error(message), { code, requestId: data?.error?.requestId });
  }
  return data;
}

export function createHttpAIService({ baseUrl = "", fetchImpl } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (!fetcher) throw new Error("HttpAIService requires fetch");

  return {
    async analyzePrompt(input, options = {}) {
      const { signal, inputSource } = options;
      const data = await post(fetcher, baseUrl, "/api/v1/ai/analyze", { input, inputSource }, signal);
      return {
        prompt: data.structuredPrompt,
        detectedIntent: data.analysis ? data.analysis.detectedIntent : "unknown"
      };
    },
    async improvePrompt(prompt, signal) {
      const data = await post(fetcher, baseUrl, "/api/v1/ai/improve", { prompt }, signal);
      return data.prompt;
    },
    async rewritePrompt(prompt, signal) {
      const data = await post(fetcher, baseUrl, "/api/v1/ai/rewrite", { prompt }, signal);
      return data.prompt;
    }
  };
}
