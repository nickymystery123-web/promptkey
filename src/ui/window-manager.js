/* WindowManager — owns window pixels: drag, magnetic snap, boot animation,
   position persistence, viewport clamping. Dispatches window actions;
   reacts to state.window changes.

   PHASE 3D RC1: the minimized bubble is now the branded PromptKey Orb —
   it drags, snaps to the NEAREST screen edge on release, and persists its
   own dock position ({x,y,dock}) independently of the main Float. */

import { act } from "../state/actions.js";

export function createWindowManager({ refs, store, storage, win }) {
  const w = win || window;
  const SNAP = 24;
  const PAD = 8;
  const ORB = 56; // PromptKey Orb size (48 on ≤700px — clamp slack is fine)
  let pos = null; // {x,y} while expanded
  let orbPos = null; // {x,y,dock} PromptKey Orb

  const clamp = (x, y, ww, hh) => ({
    x: Math.max(PAD, Math.min(x, Math.max(PAD, w.innerWidth - ww - PAD))),
    y: Math.max(PAD, Math.min(y, Math.max(PAD, w.innerHeight - hh - PAD)))
  });

  /* ---- PromptKey Orb: clamp inside viewport (56px box) ---- */
  const clampOrb = (x, y) => clamp(x, y, ORB, ORB);

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

  async function persistOrb() {
    if (orbPos) await storage.saveOrbPosition(orbPos);
  }

  function applyOrbPos(p) {
    orbPos = { ...clampOrb(p.x, p.y), dock: p.dock || (orbPos && orbPos.dock) || "right" };
    refs.minimized.style.left = orbPos.x + "px";
    refs.minimized.style.top = orbPos.y + "px";
  }

  /* ---- Orb: snap to the NEAREST screen edge (user never needs to aim) ---- */
  function snapOrbToEdge(x, y) {
    const dL = x, dR = w.innerWidth - (x + ORB), dT = y, dB = w.innerHeight - (y + ORB);
    const min = Math.min(dL, dR, dT, dB);
    if (min === dL) return { x: SNAP, y, dock: "left" };
    if (min === dR) return { x: w.innerWidth - ORB - SNAP, y, dock: "right" };
    if (min === dT) return { x, y: SNAP, dock: "top" };
    return { x, y: w.innerHeight - ORB - SNAP, dock: "bottom" };
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
    if (state.window === "minimized") {
      if (orbPos) {
        applyOrbPos(orbPos); // remembered dock position (PHASE 3D)
      } else if (pos) {
        // first minimize: derive from the Float position, then persist
        applyOrbPos(clamp(pos.x, pos.y, ORB, ORB));
        persistOrb();
      }
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

  /* ---- PromptKey Orb: release → animated snap to nearest edge + persist ---- */
  function snapOrbAndPersist() {
    const r = refs.minimized.getBoundingClientRect();
    const snapped = snapOrbToEdge(r.left, r.top);
    refs.minimized.classList.add("pk-orb-snapping");
    refs.minimized.style.left = snapped.x + "px";
    refs.minimized.style.top = snapped.y + "px";
    orbPos = snapped;
    setTimeout(() => refs.minimized.classList.remove("pk-orb-snapping"), 260);
    persistOrb();
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
      onStart: () => { refs.minimized.classList.remove("pk-orb-snapping"); },
      onMove: () => { refs.minimized.dataset.moved = "1"; },
      onEnd: (moved) => {
        // 拖动结束（有位移）才吸附 + 持久化；纯点击不改变位置
        if (moved) snapOrbAndPersist();
      }
    });
    /* PHASE 3D: restore the remembered Orb dock position (clamped to the
       current viewport — window may have resized since it was saved). */
    storage.loadOrbPosition().then((saved) => {
      if (saved) applyOrbPos(saved);
    });
    w.addEventListener("resize", () => {
      if (["expanded", "focus"].includes(store.getState().window) && pos) applyPos(pos);
      if (orbPos) applyOrbPos(orbPos); // orb never gets lost off-screen
    });
  }

  return { init, onState };
}
