/* DemoAIProvider (spec §11) — deterministic, offline, no randomness.
   - Same input → same output (keyword rules, ordered)
   - Simulated latency (injectable; 0 in tests)
   - failNext() simulates AI_ERROR for error-state testing
   - All outputs conform to the StructuredPrompt schema */

import { createStructuredPrompt, clonePrompt } from "../../models/prompt.js";

export function createDemoAIProvider(options = {}) {
  const latency = options.latency ?? { analyze: 400, improve: 900, rewrite: 900 };
  let failNextFlag = false;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function maybeFail() {
    if (failNextFlag) {
      failNextFlag = false;
      throw Object.assign(new Error("Simulated AI error"), { code: "AI_ERROR" });
    }
  }

  function cap(s) {
    s = (s || "").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function analyze(thought) {
    const t = (thought || "").trim();
    const low = t.toLowerCase();
    const has = (...words) => words.some((w) => low.includes(w));
    let detectedIntent = "general";
    let prompt;

    if (has("website", "web site", "landing", "homepage", "官网", "网站", "网页")) {
      detectedIntent = "website";
      prompt = {
        role: "Senior Product Designer",
        objective: t.length > 8 ? cap(t) : "Create a premium AI-native product website",
        context: "For a modern AI product targeting global users",
        requirements: ["Clear information hierarchy", "Responsive on desktop and mobile"],
        style: ["Minimal", "Elegant", "Human-centered"],
        output: "A complete website design and content structure"
      };
    } else if (has("creative tool", "design", "tool", "app", "工具", "设计", "应用", "产品")) {
      detectedIntent = "product-design";
      prompt = {
        role: "AI Product Designer",
        objective: cap(t) || "Design an AI-powered creative tool",
        context: "Target users: creators and designers",
        requirements: ["Intuitive core workflow", "Delightful micro-interactions"],
        style: ["Minimal", "Intuitive", "Human-centered"],
        output: "Product concept with key features and user flow"
      };
    } else if (has("travel", "trip", "itinerary", "tokyo", "旅行", "旅游", "行程", "东京", "攻略")) {
      detectedIntent = "travel";
      prompt = {
        role: "Travel Planner",
        objective: cap(t) || "Create a travel itinerary",
        context: "First-time visitor, moderate budget",
        requirements: ["Balanced pace", "Local food", "Culture and architecture"],
        style: ["Practical", "Inspiring"],
        output: "Day-by-day itinerary with highlights"
      };
    } else if (has("email", "marketing", "write", "copy", "邮件", "文案", "营销")) {
      detectedIntent = "copywriting";
      prompt = {
        role: "Professional Copywriter",
        objective: cap(t),
        context: "",
        requirements: ["Clear call to action", "Concise and engaging"],
        style: ["Professional", "Persuasive"],
        output: "Ready-to-use draft"
      };
    } else if (has("code", "function", "typescript", "python", "javascript", "代码", "函数", "开发", "bug")) {
      detectedIntent = "coding";
      prompt = {
        role: "Senior Software Engineer",
        objective: cap(t),
        context: "Production-quality code expected",
        requirements: ["Handle edge cases", "Include brief explanation"],
        style: ["Precise", "Clean"],
        output: "Working code with comments"
      };
    } else {
      // General fallback — never "no result"
      prompt = {
        role: "Expert Assistant",
        objective: cap(t),
        context: "",
        requirements: ["Clear and structured response"],
        style: ["Clear", "Professional"],
        output: ""
      };
    }
    return { prompt: createStructuredPrompt(prompt), detectedIntent };
  }

  function improve(p) {
    const q = clonePrompt(p);
    if (q.objective && !q.objective.includes("with a clear") && q.objective.length < 240) {
      q.objective = q.objective.replace(/[.。]?\s*$/, "") + ", with a clear structure and professional quality";
    }
    if (!q.style.includes("Clear")) q.style.push("Clear");
    if (!q.requirements.length || !q.requirements[0].includes("unambiguous")) {
      q.requirements.unshift("Unambiguous, explicit instructions");
    }
    return q;
  }

  function rewrite(p) {
    const q = clonePrompt(p);
    const obj = (q.objective || "").replace(/^(create|design|write|make|produce|deliver)\s+/i, "");
    q.objective = "Deliver " + obj.replace(/[.。]?\s*$/, "") + " that meets professional standards";
    q.context = q.context
      ? (q.context.includes("quality") ? q.context : q.context.replace(/[.。]?\s*$/, "") + ", quality-first")
      : "Quality-first execution expected";
    q.style = q.style.slice().sort();
    return q;
  }

  return {
    failNext() { failNextFlag = true; },

    async analyzePrompt(input) {
      await wait(latency.analyze);
      maybeFail();
      return analyze(input);
    },
    async improvePrompt(prompt) {
      await wait(latency.improve);
      maybeFail();
      return improve(prompt);
    },
    async rewritePrompt(prompt) {
      await wait(latency.rewrite);
      maybeFail();
      return rewrite(prompt);
    }
  };
}
