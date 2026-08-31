/* PK-01 Input Normalizer — conservative spoken-language cleanup (spec §6).
   Local, deterministic, no LLM. Rules are deliberately minimal:
   NEVER touch negations (不/别/没/无/never/not) or any semantic content. */

const STANDALONE_FILLERS = ["呃", "嗯", "额"];
const EDGE_FILLERS = ["那个", "就是"]; // only stripped at clause edges

export function normalizeInput(text) {
  let out = String(text || "");

  // 1. collapse consecutive repeated 2–4-char CJK sequences: 整体整体 → 整体
  //    (1-char reduplications like 看看/想想 are legitimate — never touched)
  out = out.replace(/([\u4e00-\u9fff]{2,4})\1+/g, "$1");

  // 2. standalone fillers (whole-token only)
  STANDALONE_FILLERS.forEach((f) => {
    out = out.replace(new RegExp(`(^|[\\s，。、；,.;!?])${f}(?=[\\s，。、；,.;!?]|$)`, "g"), "$1");
  });

  // 3. edge fillers after punctuation or at start: “，就是我想…” → “，我想…”
  EDGE_FILLERS.forEach((f) => {
    out = out.replace(new RegExp(`(^|[，。、；,.;!?])\\s*${f}(?=[^，。、；,.;!?])`, "g"), "$1");
  });

  // 4. whitespace & punctuation tidying (+ dangling edge punctuation after filler removal)
  out = out.replace(/[ \t]+/g, " ").replace(/\s+([，。、；,.;!?？！])/g, "$1").trim();
  out = out.replace(/^[，。、；,.;!?？！]+\s*/, "").trim();

  return out;
}

/* Negation / constraint clauses — PK-07 also uses this. */
export function extractConstraintClauses(text) {
  const clauses = [];
  const re = /(不要|不能|别|不得|无需|不用|避免|禁止|不可以|never|do not|don't|must not)[^，。；,.;!?\n]*/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const clause = m[0].trim();
    if (clause.length >= 3) clauses.push(clause);
  }
  return clauses;
}
