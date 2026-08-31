/* ClipboardDelivery — DeliveryService demo provider (spec §18).
   Clipboard specifics isolated here; swap for SendToAIProvider later. */

export function createClipboardDelivery(nav, doc) {
  const clipboard = nav || (typeof navigator !== "undefined" ? navigator : {});
  const documentRef = doc || (typeof document !== "undefined" ? document : null);

  function legacyCopy(text) {
    return new Promise((resolve, reject) => {
      if (!documentRef) return reject(new Error("No document for legacy copy"));
      const ta = documentRef.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      documentRef.body.appendChild(ta);
      ta.select();
      try {
        const ok = documentRef.execCommand("copy");
        documentRef.body.removeChild(ta);
        ok ? resolve() : reject(new Error("execCommand copy failed"));
      } catch (e) {
        documentRef.body.removeChild(ta);
        reject(e);
      }
    });
  }

  return {
    /* Called during "sending" — clipboard writes need a gesture,
       so we only mark the channel as prepared. */
    async deliver() {
      return { ok: true, channel: "clipboard", prepared: true };
    },

    /* Called from the Copy button (user gesture). */
    async copy(text) {
      if (clipboard.clipboard && clipboard.clipboard.writeText) {
        try {
          await clipboard.clipboard.writeText(text);
          return;
        } catch (e) { /* fall through to legacy */ }
      }
      await legacyCopy(text);
    }
  };
}
