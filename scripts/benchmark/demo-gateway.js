/* Benchmark demo gateway — deterministic, NO LLM.
   Produces a minimal, honest LLM-shaped response from local rules only
   (normalizer + terminology hints + local structurer). Never peeks at
   fixture expectations — it is the "rule-based floor" for benchmarking.
   Production intelligence (real mode) uses the DeepSeek gateway. */

import { normalizeInput, extractConstraintClauses } from "../../server/ai/skills/intent-compiler/normalizer.js";
import { createTerminologyResolver } from "../../server/ai/skills/intent-compiler/terminology.js";
import { INTENT_TASKS } from "../../server/ai/skills/intent-compiler/intent.js";

const terms = createTerminologyResolver();

const TASK_KEYWORDS = [
  ["multi_step", /先.*然后|先.*再|然后.*再|再.*给我/],
  ["ui_design", /页面|首页|按钮|UI|设计|视觉|高级|美观|好看|图标|布局/],
  ["data_analysis", /分析|数据|统计|查询|数据库|SQL|JSON/],
  ["presentation", /PPT|汇报|演示|幻灯片/],
  ["product_design", /PRD|产品/],
  ["translation", /翻译|英文|英文版/],
  ["debugging", /bug|报错|错误|调不通|问题|修一下/],
  ["coding", /代码|接口|API|React|函数|脚本|写个|写一个|重构/],
  ["rewriting", /重新|润色|优化|整理|重写|正式|专业|乱/],
  ["writing", /写|介绍|文案|文章/]
];

function guessTask(text) {
  for (const [task, re] of TASK_KEYWORDS) {
    if (re.test(text)) return task;
  }
  return "general";
}

/* Extract the raw input from the compiler's user-content envelope. */
function extractRawInput(userContent) {
  const m = /User raw input[^\n]*\n("(?:[^"\\]|\\.)*")/.exec(userContent || "");
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* fallthrough */ }
  }
  // last resort: the whole payload (should not happen)
  return "";
}

export function createBenchmarkDemoGateway() {
  return {
    async chatJson({ system, user }, ctx) {
      const raw = extractRawInput(user);
      const normalized = normalizeInput(raw);
      const hints = terms.scan(raw);
      const highConf = hints.filter((h) => h.confidence >= 0.7);
      const lowConf = hints.filter((h) => h.confidence < 0.7);
      return {
        correctedInput: normalized,
        corrections: highConf.map((h) => ({
          original: h.original, corrected: h.corrected,
          confidence: h.confidence, reason: h.reason
        })),
        intent: {
          task: guessTask(normalized),
          object: "",
          goal: [normalized],
          context: [],
          requirements: [],
          constraints: extractConstraintClauses(normalized),
          preferences: [],
          expectedOutput: "",
          subtasks: []
        },
        inferredIntent: [],
        aiSuggestions: [],
        uncertainties: lowConf.map((h) => ({
          type: "terminology", original: h.original,
          candidates: [h.corrected], confidence: h.confidence
        })),
        optimizedPrompt: normalized,
        structured: null, // compiler's local structurer builds it
        fidelity: { intentFidelity: 1, semanticChanges: [], addedAssumptions: [], removedRequirements: [] }
      };
    }
  };
}
