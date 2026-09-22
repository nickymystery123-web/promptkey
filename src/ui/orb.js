/* PromptKey Orb Controller — 状态管道与预留交互桩（PHASE 3D RC1）。

   · 8 状态通过 data-state 属性 + .pk-orb--* class 双通道驱动
     （CSS 两条通道等价，测试可断言任意一条）。
   · hover / press：指针事件驱动（transient）。
   · listening / processing / ready / error：由 store 订阅驱动。
     - listening  ← state.voice === "listening"
     - processing ← state.refinePending（REFINE 异步进行中）
     - ready      ← refinePending true→false（成功完成，一次 pulse）
     - error      ← state.error 变化（短暂震动）
   · 状态优先级：press > error > processing > ready > listening > hover > idle
     （ready 为一次性 pulse 反馈，优先于持续性的 listening）。

   RC2 预留桩（PHASE 3D 主提示词 §2.6，只留事件通道、无 UI）：
   · dblclick → 派发 "pk-orb-dblclick"（未来：直接进入 Voice Capture）
   · 长按 >500ms 未移动 → 派发 "pk-orb-longpress"（未来：Quick Menu） */

const TRANSIENT_STATES = ["hover", "press", "ready", "error"];

export function computeOrbState(state, prev, transient) {
  if (transient.press) return "press";
  if (transient.error) return "error";
  if (state.refinePending) return "processing";
  if (transient.ready) return "ready";
  if (state.voice === "listening") return "listening";
  if (transient.hover) return "hover";
  return "idle";
}

export function createOrbController({ refs, win }) {
  const w = win || window;
  const transient = { hover: false, press: false, ready: false, error: false };
  // 最近一次 store 状态（指针事件回调里没有新 state 时用它重算）
  let lastState = { voice: "idle", refinePending: false, error: null };
  let readyTimer = null;
  let errorTimer = null;

  function apply(stateName) {
    const orb = refs.minimized;
    if (!orb) return;
    if (orb.dataset.state !== stateName) orb.dataset.state = stateName;
    TRANSIENT_STATES.concat(["listening", "processing"]).forEach((s) => {
      orb.classList.toggle("pk-orb--" + s, s === stateName);
    });
  }

  function refresh() {
    apply(computeOrbState(lastState, null, transient));
  }

  function onState(state, prev) {
    lastState = state;
    // refine 成功完成（pending true→false 且无新错误）→ ready pulse 一次
    if (prev && prev.refinePending && !state.refinePending && !state.error) {
      transient.ready = true;
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = setTimeout(() => { transient.ready = false; refresh(); }, 460);
    }
    // 新错误 → error 短暂震动
    if (state.error && (!prev || state.error !== prev.error)) {
      transient.error = true;
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { transient.error = false; refresh(); }, 320);
    }
    apply(computeOrbState(state, prev, transient));
  }

  function init() {
    const orb = refs.minimized;
    if (!orb) return;
    /* ---- 指针驱动的 hover / press（视觉与 CSS :hover 等价，双通道冗余） ---- */
    orb.addEventListener("pointerenter", () => {
      transient.hover = true;
      refresh();
    });
    orb.addEventListener("pointerleave", () => {
      transient.hover = false;
      transient.press = false;
      refresh();
    });
    orb.addEventListener("pointerdown", () => {
      transient.press = true;
      refresh();
    });
    orb.addEventListener("pointerup", () => {
      transient.press = false;
      refresh();
    });
    orb.addEventListener("pointercancel", () => {
      transient.press = false;
      refresh();
    });

    /* ---- RC2 预留桩：双击 / 长按 Quick Menu（只派发事件，无任何 UI） ---- */
    orb.addEventListener("dblclick", (e) => {
      // RC2: reserved — future "direct Voice Capture" entry point.
      orb.dispatchEvent(new (w.CustomEvent || CustomEvent)("pk-orb-dblclick", { bubbles: true }));
    });
    let lpTimer = null;
    orb.addEventListener("pointerdown", () => {
      // RC2: reserved — future Quick Menu (Voice / Capture / Queue).
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        orb.dispatchEvent(new (w.CustomEvent || CustomEvent)("pk-orb-longpress", { bubbles: true }));
      }, 500);
    });
    const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    orb.addEventListener("pointerup", cancelLp);
    orb.addEventListener("pointercancel", cancelLp);
    orb.addEventListener("pointermove", cancelLp); // 拖动开始即取消长按
  }

  return { init, onState, _transient: transient };
}
