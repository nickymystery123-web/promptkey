/* LocalStorageService — StorageService implementation (spec §19).

   interface StorageService {
     saveSession(session): Promise<void>
     loadSession(id): Promise<PromptSession | null>
     clearSession(id): Promise<void>
     savePosition(pos): Promise<void>   // window manager uses these two
     loadPosition(): Promise<{x,y} | null>
     saveInbox(thoughts): Promise<void> // 3C-3A: Creative Inbox persistence
     loadInbox(): Promise<Thought[]>
     clearInbox(): Promise<void>
     saveDraft(text): Promise<void>     // 3C-3A: Composer draft persistence
     loadDraft(): Promise<string>
     clearDraft(): Promise<void>
   }

   All reads/writes are wrapped in try/catch (safeGet/safeSet/safeRemove), so a
   missing/unavailable/corrupt localStorage (private mode, quota, bad JSON)
   degrades silently — the in-session product keeps working (3C-3A §4.6).

   Future: BackendStorage / Database / Cloud Sync — core logic unchanged. */

const POS_KEY = "pk-float:position";
const ORB_POS_KEY = "pk-float:orb-pos"; // PHASE 3D: PromptKey Orb 位置持久化 {x,y,dock}
const SESSION_KEY = "pk-float:session:";
const INBOX_KEY = "pk-float:inbox";
const DRAFT_KEY = "pk-float:draft";

/* 3C-3A §4.1/§4.2: persist the full Thought record (id/originalText/
   refinedText/source/createdAt/updatedAt — every field the UI and logic use).
   On load, each entry is validated & sanitized; anything malformed is dropped
   rather than crashing the restore. */
function sanitizeThought(t) {
  if (!t || typeof t !== "object") return null;
  if (typeof t.id !== "string" || !t.id) return null;
  if (typeof t.originalText !== "string" || !t.originalText.trim()) return null;
  return {
    id: t.id,
    originalText: t.originalText,
    refinedText: typeof t.refinedText === "string" && t.refinedText.trim() ? t.refinedText : null,
    source: t.source === "voice" ? "voice" : "text",
    createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString(),
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : new Date().toISOString()
  };
}

export function createLocalStorageService(store) {
  const ls = store || (typeof localStorage !== "undefined" ? localStorage : null);

  function safeGet(key) {
    try { return ls ? ls.getItem(key) : null; } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { if (ls) ls.setItem(key, value); } catch (e) { /* quota / private mode */ }
  }
  function safeRemove(key) {
    try { if (ls) ls.removeItem(key); } catch (e) { }
  }

  return {
    async saveSession(session) {
      if (!session || !session.id) return;
      safeSet(SESSION_KEY + session.id, JSON.stringify(session));
    },
    async loadSession(id) {
      const raw = safeGet(SESSION_KEY + id);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
    async clearSession(id) {
      safeRemove(SESSION_KEY + id);
    },
    async savePosition(pos) {
      safeSet(POS_KEY, JSON.stringify(pos));
    },
    async loadPosition() {
      const raw = safeGet(POS_KEY);
      if (!raw) return null;
      try {
        const p = JSON.parse(raw);
        return typeof p.x === "number" && typeof p.y === "number" ? p : null;
      } catch (e) { return null; }
    },
    /* ---- PromptKey Orb position persistence (PHASE 3D RC1) ----
       { x, y, dock } · dock ∈ left|right|top|bottom — validated on load,
       corrupt entries degrade to null (fresh default position). */
    async saveOrbPosition(pos) {
      if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
      safeSet(ORB_POS_KEY, JSON.stringify(pos));
    },
    async loadOrbPosition() {
      const raw = safeGet(ORB_POS_KEY);
      if (!raw) return null;
      try {
        const p = JSON.parse(raw);
        if (typeof p.x !== "number" || typeof p.y !== "number") return null;
        const dock = ["left", "right", "top", "bottom"].includes(p.dock) ? p.dock : "right";
        return { x: p.x, y: p.y, dock };
      } catch (e) { return null; }
    },
    /* ---- Creative Inbox persistence (3C-3A §4) ---- */
    async saveInbox(thoughts) {
      if (!Array.isArray(thoughts)) return;
      safeSet(INBOX_KEY, JSON.stringify({ v: 1, thoughts }));
    },
    async loadInbox() {
      const raw = safeGet(INBOX_KEY);
      if (!raw) return [];
      try {
        const data = JSON.parse(raw);
        const list = Array.isArray(data)
          ? data
          : (data && typeof data === "object" && Array.isArray(data.thoughts) ? data.thoughts : null);
        if (!list) return [];
        return list.map(sanitizeThought).filter(Boolean); // corrupt entries dropped, order kept
      } catch (e) { return []; } // corrupt storage → empty inbox, never a crash
    },
    async clearInbox() {
      safeRemove(INBOX_KEY);
    },
    /* ---- Composer draft persistence (3C-3A §6) ---- */
    async saveDraft(text) {
      if (typeof text !== "string" || !text) { safeRemove(DRAFT_KEY); return; }
      safeSet(DRAFT_KEY, JSON.stringify({ v: 1, text }));
    },
    async loadDraft() {
      const raw = safeGet(DRAFT_KEY);
      if (!raw) return "";
      try {
        const data = JSON.parse(raw);
        if (typeof data === "string") return data; // legacy bare-string format
        return data && typeof data.text === "string" ? data.text : "";
      } catch (e) { return ""; }
    },
    async clearDraft() {
      safeRemove(DRAFT_KEY);
    }
  };
}
