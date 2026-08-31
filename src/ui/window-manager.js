/* WindowManager — owns window pixels: drag, magnetic snap, boot animation,
   position persistence, viewport clamping. Dispatches window actions;
   reacts to state.window changes. */

import { act } from "../state/actions.js";

export function createWindowManager({ refs, store, storage, win }) {
  const w = win || window;
  const SNAP = 24;
  const PAD = 8;
  let pos = null; // {x,y} while expanded

  const clamp = (x, y, ww, hh) => ({
    x: Math.max(PAD, Math.min(x, Math.max(PAD, w.innerWidth - ww - PAD))),
    y: Math.max(PAD, Math.min(y, Math.max(PAD, w.innerHeight - hh - PAD)))
  });

  function applyPos(p) {
    const rect = refs.float.getBoundingClientRect();
    pos = clamp(p.x, p.y, rect.width || 620, rect.height || 520);
    refs.float.style.left = pos.x + "px";
    refs.float.style.top = pos.y + "px";
  }

  function defaultPos() {
    const rect = refs.float.getBoundingClientRect();
    const ww = rect.width || Math.min(620, w.innerWidth * 0.92);
    const hh = rect.height || 520;
    return clamp(w.innerWidth - ww - 24, w.innerHeight - hh - 24, ww, hh);
  }

  async function persist() {
    if (pos) await storage.savePosition({ x: pos.x, y: pos.y, state: store.getState().window });
  }

  /* ---- boot animation: dot → bar → surface → workspace → controls ---- */
  function playBoot() {
    const f = refs.float;
    f.classList.remove("pk-boot-1", "pk-boot-2", "pk-boot-3", "pk-boot-4");
    f.classList.add("pk-boot");
    const steps = [[30, "pk-boot-1"], [200, "pk-boot-2"], [380, "pk-boot-3"], [540, "pk-boot-4"]];
    steps.forEach(([ms, cls]) => setTimeout(() => f.classList.add(cls), ms));
    setTimeout(() => {
      f.classList.remove("pk-boot", "pk-boot-1", "pk-boot-2", "pk-boot-3", "pk-boot-4");
      persist();
    }, 700);
  }

  /* ---- react to state.window transitions ---- */
  function onState(state, prev) {
    if (state.window === prev.window) return;

    if (state.window === "expanded" || state.window === "focus") {
      if (["hidden", "launcher"].includes(prev.window)) {
        storage.loadPosition().then((saved) => {
          applyPos(saved || defaultPos());
          if (prev.window === "hidden" || prev.window === "launcher") playBoot();
        });
      } else if (prev.window === "minimized" && pos) {
        applyPos(pos); // restore keeps pixels & content
      }
    }
    if (state.window === "minimized" && pos) {
      const c = clamp(pos.x, pos.y, 64, 64);
      refs.minimized.style.left = c.x + "px";
      refs.minimized.style.top = c.y + "px";
    }
    persist();
  }

  /* ---- generic drag helper (pointer events) ---- */
  function makeDraggable(handle, target, { onStart, onMove, onEnd } = {}) {
    let sx = 0, sy = 0, bx = 0, by = 0, dragging = false, moved = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".pk-win-btn")) return;
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = target.getBoundingClientRect();
      bx = r.left; by = r.top;
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
      if (onStart) onStart();
      document.body.classList.add("pk-dragging");
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const r = target.getBoundingClientRect();
      const c = clamp(bx + dx, by + dy, r.width, r.height);
      target.style.left = c.x + "px";
      target.style.top = c.y + "px";
      if (onMove) onMove(c);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("pk-dragging");
      if (onEnd) onEnd(moved);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function snapToEdge() {
    const r = refs.float.getBoundingClientRect();
    let x = r.left, y = r.top;
    const dL = x, dR = w.innerWidth - (x + r.width);
    const dT = y, dB = w.innerHeight - (y + r.height);
    const min = Math.min(dL, dR, dT, dB);
    if (min >= SNAP) return;
    if (min === dL) x = SNAP;
    else if (min === dR) x = w.innerWidth - r.width - SNAP;
    else if (min === dT) y = SNAP;
    else y = w.innerHeight - r.height - SNAP;
    refs.float.classList.add("pk-snapping");
    refs.float.style.left = x + "px";
    refs.float.style.top = y + "px";
    pos = { x, y };
    setTimeout(() => refs.float.classList.remove("pk-snapping"), 240);
  }

  function init() {
    makeDraggable(refs.dragHandle, refs.float, {
      onStart: () => { refs.float.classList.add("pk-dragging"); refs.float.classList.remove("pk-snapping"); },
      onMove: (c) => { pos = c; },
      onEnd: () => {
        refs.float.classList.remove("pk-dragging");
        snapToEdge();
        persist();
      }
    });
    makeDraggable(refs.minimized, refs.minimized, {
      onMove: () => { refs.minimized.dataset.moved = "1"; }
    });
    w.addEventListener("resize", () => {
      if (["expanded", "focus"].includes(store.getState().window) && pos) applyPos(pos);
    });
  }

  return { init, onState };
}
