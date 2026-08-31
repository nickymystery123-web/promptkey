/* PK-02 Terminology Resolver (spec §10/§11).
   Three-layer architecture: Global → Project → User (interface ready).
   The dictionary is CANDIDATE KNOWLEDGE, never an automatic replacement —
   every hit is a hypothesis with confidence + optional context requirement. */

const GLOBAL_TERMS = [
  { canonical: "DeepSeek", variants: ["deep seek", "deepseek", "deep-see", "deepseak"], confidence: 0.98, reason: "contextual terminology match" },
  { canonical: "ChatGPT", variants: ["chat gpt", "chatgpt", "chat-gpt"], confidence: 0.97, reason: "contextual terminology match" },
  { canonical: "SQL", variants: ["sequel", "s q l"], confidence: 0.9, reason: "ASR homophone", requiresContext: /查|数据|query|database|库|表|select/i },
  { canonical: "JSON", variants: ["jason"], confidence: 0.9, reason: "ASR homophone", requiresContext: /数据|格式|parse|解析|字段/i },
  { canonical: "API", variants: ["a p i"], confidence: 0.92, reason: "spelled-out acronym" },
  { canonical: "JavaScript", variants: ["java script"], confidence: 0.95, reason: "split token" },
  { canonical: "TypeScript", variants: ["type script"], confidence: 0.95, reason: "split token" },
  { canonical: "Node.js", variants: ["node js", "node"], confidence: 0.8, reason: "common shorthand", requiresContext: /后端|服务|server|运行/i },
  { canonical: "Next.js", variants: ["next js"], confidence: 0.95, reason: "split token" },
  { canonical: "GitHub", variants: ["git hub"], confidence: 0.95, reason: "split token" },
  { canonical: "Claude", variants: ["claude code"], confidence: 0.6, reason: "possible product reference" }
];

/* Well-known canonical terms — used by the fidelity guard to verify
   technical terms are preserved, never altered (spec §41/§42). */
const CANONICAL_TECH_TERMS = [
  "DeepSeek", "ChatGPT", "Claude", "Cursor", "OpenAI", "Gemini", "Copilot",
  "SQL", "API", "JSON", "HTTP", "HTTPS", "CSS", "HTML", "SDK", "PRD", "SaaS",
  "UI", "UX", "AI", "LLM", "NLP", "GPU", "CPU",
  "Python", "JavaScript", "TypeScript", "React", "Vue", "Angular", "Svelte",
  "Node.js", "Next.js", "Deno", "Git", "GitHub", "GitLab", "Figma", "Docker",
  "Kubernetes", "Linux", "macOS", "Windows", "iOS", "Android"
];

export function createTerminologyResolver({ projectTerms = [], userTerms = [] } = {}) {
  // later layers win on canonical conflicts
  const dictionary = [...GLOBAL_TERMS, ...projectTerms, ...userTerms];

  function normalizeForMatch(s) {
    return s.toLowerCase().replace(/\s+/g, " ");
  }

  /* Scan text for correction candidates. Context-required entries only
     surface when the surrounding text matches their context pattern. */
  function scan(text) {
    const hay = normalizeForMatch(text);
    const hits = [];
    for (const entry of dictionary) {
      for (const variant of entry.variants) {
        if (!hay.includes(normalizeForMatch(variant))) continue;
        if (entry.requiresContext && !entry.requiresContext.test(text)) {
          hits.push({ original: variant, corrected: entry.canonical, confidence: 0.5, reason: entry.reason + " (no supporting context)" });
        } else {
          hits.push({ original: variant, corrected: entry.canonical, confidence: entry.confidence, reason: entry.reason });
        }
        break; // one hit per entry
      }
    }
    return hits;
  }

  /* Canonical tech terms present in a text (for fidelity preservation checks).
     Short/acronym terms (AI, UI, API, SQL, PRD…) must match as standalone
     tokens — otherwise "HT mail" would falsely count as containing "AI"
     (substring "ai" inside "mail"). Longer terms may match as substrings. */
  function techTermsIn(text) {
    const lower = text.toLowerCase();
    return CANONICAL_TECH_TERMS.filter((t) => {
      const key = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key.length <= 3) {
        return new RegExp(`(^|[^a-z0-9])${key}($|[^a-z0-9])`).test(lower);
      }
      return lower.includes(key);
    });
  }

  return { scan, techTermsIn };
}
