/* LocalStorageService — StorageService implementation (spec §19).

   interface StorageService {
     saveSession(session): Promise<void>
     loadSession(id): Promise<PromptSession | null>
     clearSession(id): Promise<void>
     savePosition(pos): Promise<void>   // window manager uses these two
     loadPosition(): Promise<{x,y} | null>
   }

   Future: BackendStorage / Database / Cloud Sync — core logic unchanged. */

const POS_KEY = "pk-float:position";
const SESSION_KEY = "pk-float:session:";

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
    }
  };
}
