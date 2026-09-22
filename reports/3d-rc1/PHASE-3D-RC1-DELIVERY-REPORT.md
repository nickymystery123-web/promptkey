# PHASE 3D — RC1 DELIVERY REPORT

> Stage: PHASE 3D · RC1 · PromptKey Orb + Release-Candidate 收尾
> Verdict: **PASS**
> Executed against master prompt in `d:\KEY\PromptKey_Float_Complete_Package\PHASE-3D-RC1-MASTER-EXECUTION-PROMPT.txt`.

---

## 1. Executive Summary

Phase 3D-RC1 delivers two things: the branded **PromptKey Orb** (P0 — the global AI Input Port, first step of the "AI 物理化" strategy) and the **RC1 closeout checklist** (P1 — error-matrix re-verification, security re-lint, performance spot-check, full regression).

| # | Priority | Deliverable | Contract | Verdict |
|---|----------|-------------|----------|---------|
| P0 | CRITICAL | PromptKey Orb — 56px Monogram (P + Keyhole 负空间), 8 states, drag + edge-snap + dock persistence | 28/28 ORB unit tests + Browser E2E 全链路 | **PASS** |
| P0 | CRITICAL | Orb 状态管道 — store → data-state 双通道 (idle/hover/press/listening/processing/ready/error) | ORB-STATE 单测 + E2E hover 双通道验证 | **PASS** |
| P1 | HIGH | 错误处理矩阵 10 项复验（缺项补测，不改实现） | 9 项既有覆盖 + 2 新增 ERR-CLIP 测试 | **PASS** |
| P1 | HIGH | 安全 lint / 性能快检 / 全量回归 / FROZEN 审计 | lint PASS · longTasks=0 · 346/346 · FROZEN 47/47 | **PASS** |

Final totals: unit tests **346 / 346 PASS** (316 baseline + 28 Orb + 2 ERR-CLIP) · lint **PASS** · build **PASS** · FROZEN SHA256 replay **47 / 47 = 0 changes** · Browser E2E core journey **PASS** · clean-tab console **0 SEVERE**.

---

## 2. Baseline

| Metric | Before (3C-3C) | After (3D-RC1) |
|--------|---------------:|---------------:|
| Unit tests | 316 / 316 | 346 / 346 |
| New test modules | — | 2 (`orb.test.js`, `rc1-error-matrix.test.js`) |
| New source modules | — | 1 (`src/ui/orb.js`) |
| Lint | PASS | PASS |
| Build | PASS | PASS (54 files, incl. `src/ui/orb.js`) |
| FROZEN files | 47 / 47 | 47 / 47 (SHA256 replay vs `reports/frozen-baseline-3c3b.txt`) |
| Browser console SEVERE | 0 | 0 (clean-tab journey) |

---

## 3. P0 · PromptKey Orb

### 3.1 Brand visual (GATE A)

`#pk-minimized` rebuilt as the branded Orb (spec §2):

- **Monogram**: inline SVG (viewBox `0 0 24 24`) — P 竖笔 + 半圆环腔体，右下圆点为 keyhole / input-port 负空间提示。旧的 `.pk-min-dot` 圆点与 `.pk-min-pk` "PK" 文字节点已从 `index.html` 删除（E2E 断言 `document.querySelector('.pk-min-dot') === null`）。
- **尺寸**: 56×56px 桌面；`@media (max-width:700px)` → 48×48px、glyph 24→20px（E2E 实测 375px viewport = 48px / 1280px = 56px）。
- **材质**: 深色半透明背景 `rgba(18,18,20,.72)` + `backdrop-filter: blur(10px) saturate(1.2)` 毛玻璃 + 极细边框 + 紫色内发光 `inset 0 0 12px rgba(120,90,255,.18)`。
- **8 状态 CSS** 双通道驱动（`data-state` 属性 + `.pk-orb--*` 类）: idle / hover / press / expand / listening / processing / ready / error，关键帧 `pk-orb-breathe / pk-orb-spin / pk-orb-pulse / pk-orb-shake`。
- **prefers-reduced-motion**: 呼吸/旋转/pulse/震动动画全部关闭，仅保留透明度过渡（`orb.test.js` ORB-VISUAL 断言）。

### 3.2 Interaction (GATE B — 28/28 单测 + Browser E2E)

| Capability | Implementation | Evidence |
|------------|----------------|----------|
| 单击展开 / 最小化回 Orb | `main.js` click 监听 + `dataset.moved` 防拖动误触（拖动后跳过 click） | E2E: orb click → `windowState=expanded`；Minimize → orb visible |
| 拖动（pointer events） | `window-manager.js` `makeDraggable(orb, orb)`，>3px 位移记 `moved` | E2E: 合成 pointer 序列拖动 |
| 释放吸附最近边缘 | `snapOrbToEdge` — SNAP=24，四边距离取最小 | E2E: 拖到底部 → y=746 (=826−56−24) dock=bottom；拖到右 → x=792 (=872−56−24) dock:right |
| 位置独立持久化 | `local-storage.js` 新增 `saveOrbPosition/loadOrbPosition`，键 `pk-float:orb-pos`，`{x,y,dock}` | E2E: localStorage 快照与吸附结果逐字段一致 |
| 刷新恢复 + 超界/resize clamp | `init()` 异步恢复 + clamp；`resize` 监听 re-clamp（Orb 永不丢失屏外） | E2E: reload → orb 恢复 (792,372) |
| 键盘 Enter/Space 展开、Tab 可聚焦 | 原生 `<button>` + `:focus-visible` 焦点环（CSS） | E2E snapshot: orb 获得焦点 ref；ORB-INT 单测 |
| 双击/长按预留桩 | `orb.js` `dblclick` + 长按计时器事件通道（RC2 注释，无 UI） | ORB-INT-10 单测 |
| 主 Float 拖动/吸附/持久化零回归 | 未触碰原 `makeDraggable(refs.dragHandle, refs.float)` 路径 | 既有 316 测试全绿 |

### 3.3 State pipeline (GATE C)

`src/ui/orb.js` — `createOrbController` 订阅 store，`computeOrbState` 优先级：
`press > error > processing > ready > listening > hover > idle`

- `refinePending` → processing（外圈缓旋）；REFINE 成功 → ready 一次 pulse；失败 → error 震动（ORB-STATE-05: state.error → 震动后回 idle）
- `voice === "listening"` → listening 呼吸
- 指针事件驱动 hover/press；`lastState` 缓存避免回调时 state 为 null
- E2E 实测 hover 双通道：`pointerenter` → `data-state="hover"` + `className="pk-orb pk-orb--hover"`；`pointerleave` → 回 idle

### 3.4 Files changed (all NON-FROZEN)

| File | Change |
|------|--------|
| `index.html` | Orb DOM：Monogram SVG + ring + glyph（删除 `pk-min-dot` / `pk-min-pk`） |
| `css/float.css` | Orb 8 状态规则、4 组 keyframes、响应式 48px、reduced-motion 降级 |
| `src/ui/orb.js` | **新增** — Orb 控制器 + 状态计算 + 预留桩 |
| `src/ui/window-manager.js` | Orb 拖动/吸附/持久化/恢复/clamp（主 Float 路径零改动） |
| `src/services/storage/local-storage.js` | `saveOrbPosition` / `loadOrbPosition`（独立键 `pk-float:orb-pos`） |
| `src/main.js` | `createOrbController` 初始化 + store 订阅接入 |
| `tests/orb.test.js` | **新增** — 28 项专项契约测试 |
| `tests/rc1-error-matrix.test.js` | **新增** — ERR-CLIP-01/02（错误矩阵缺项补测） |
| `review/3d-rc1/responsive.html` | **新增** — 响应式验收 harness（iframe 加载真实 `/`，非交付物） |

---

## 4. P1 · RC1 收尾清单 (SPEC B)

### 4.1 错误处理矩阵复验（10/10 — 已覆盖项列测试 ID，缺项补测试）

| # | 错误类别 | 覆盖测试 ID | 用户提示 | 不崩溃 | 状态 |
|---|---------|------------|---------|--------|------|
| 1 | API Timeout | `gateway.test.js` #5 (AI_TIMEOUT)；`http-service.test.js`（AI_TIMEOUT 不降级 demo） | AI_TIMEOUT | ✓ | 既有 |
| 2 | Network Error | `http-service.test.js` (→ NETWORK_ERROR)；`3c-3a.test.js` AI-3（Demo fallback + 恢复回 real） | NETWORK_ERROR | ✓ | 既有 |
| 3 | AI Provider Error | `deepseek-provider.test.js` #7 (HTTP 500/503 → AI_PROVIDER_UNAVAILABLE)、#15 | AI_ERROR / AI_PROVIDER_UNAVAILABLE | ✓ | 既有 |
| 4 | Invalid AI Response | `gateway.test.js` #4 (malformed → AI_BAD_RESPONSE)；`deepseek-provider.test.js` #9 | AI_BAD_RESPONSE | ✓ | 既有 |
| 5 | JSON Parse Error | `http-service.test.js` (non-JSON → NETWORK_ERROR)；`deepseek-provider.test.js` #9 (model JSON fails schema) | NETWORK_ERROR / AI_BAD_RESPONSE | ✓ | 既有 |
| 6 | Speech Recognition Error | `voice-loop.test.js` L/M/N（可恢复 + 重试 + 错误后打字仍可用） | VOICE_* + retry hint | ✓ | 既有 |
| 7 | Microphone Permission | `voice-loop.test.js` K (not-allowed → VOICE_UNAVAILABLE)；`voice-error-reset.test.js` 1/1b | VOICE_UNAVAILABLE | ✓ | 既有 |
| 8 | Empty Input | `machine.test.js` (EMPTY_INPUT)；`3c-2b.test.js` E3/UI-19（空 REFINE no-op + 双门禁） | 门禁禁用 | ✓ | 既有 |
| 9 | **Clipboard Error** | **`rc1-error-matrix.test.js` ERR-CLIP-01/02（本阶段新增）** | "Copy failed — select the text manually." | ✓ | **新增** |
| 10 | Storage Error | `3c-3a.test.js` TP-6 (corrupt → [])、TP-8 (quota/blocked → 会话内存活) | 降级运行 | ✓ | 既有 |

ERR-CLIP-01: copy 失败 → `DELIVERY_ERROR` + 用户可理解提示；Thought 不丢失。
ERR-CLIP-02: 失败后重试成功 → COPIED toast；下一次用户动作（UPDATE_INPUT）清除 error，会话存活。（实现不改 —— error 清除语义与 voice-error-reset 既有契约一致。）

### 4.2 安全合规复验

```
D:\Tools\nodejs\node.exe scripts/lint.js
→ lint OK — frontend/backend guardrails hold (DOM only in ui/+main.js, env only in config/env.js, no secrets in frontend)
```

- SECRET_PATTERN 前端扫描 PASS（无 API key 形态字符串）
- 所有 AI 调用仍经 service layer（`http-service.js` → `/api/v1/ai/*`），UI 无直连（lint DOM 架构守卫同时通过）

### 4.3 性能快检

| 检查项 | 结果 |
|--------|------|
| Orb 拖动渲染路径 | `makeDraggable` pointermove 内仅写 `style.left/top`（clamp 纯计算，无 DOM 查询）；onMove 回调只设 dataset 标记 | 
| 展开/收起动画 | Browser E2E `PerformanceObserver('longtask')` 实测 **longTasks = []**（展开 + 收起 + 吸附全程零长任务） |
| CSS 动画 | 仅 transform/opacity 参与动画（transition:transform .18s），不触发布局级联 |

---

## 5. Full Regression (GATE E)

### 5.1 Automated

```
D:\Tools\nodejs\node.exe --test
# tests 346  pass 346  fail 0   (duration ≈ 3.3s)

D:\Tools\nodejs\node.exe scripts/lint.js   → PASS
D:\Tools\nodejs\node.exe scripts/build.js  → PASS (54 files, 40/40 modules import cleanly)
```

### 5.2 Core journey (Browser E2E — live, native events)

```
TRY PROMPTKEY → Float 展开 ✓
 ↓ idle 视图点击 → Composer 激活 ✓
 ↓ 输入 32 字中文 ✓（REFINE/SUBMIT 门禁解锁）
 ↓ REFINE → toast "REFINED → INBOX" · Inbox 0→1 · Composer 原文保留 ✓
 ↓ Thought 卡片（原文 + REFINED 预览 + COPY/USE/EXPAND） ✓
 ↓ USE → Composer 追加 "\n\n" + refined（非覆盖） ✓
 ↓ SUBMIT → understanding → REVIEW（结构化 sections + IMPROVE/REWRITE + USE ORIGINAL/OPTIMIZED） ✓
 ↓ CONFIRM & SEND → DELIVERED ✓
 ↓ Minimize → Orb 出现（idle 状态） ✓
 ↓ 刷新 → Inbox 持久化（1 Thought 保留）· Orb 位置恢复 (792,372) ✓
 ↓ Orb 单击 → 再展开 ✓
```

### 5.3 Orb 专项 E2E

| 场景 | 结果 |
|------|------|
| 视觉（56px / Monogram SVG / ring / tip / aria-label="打开 PromptKey" / 旧节点已删） | ✓ |
| 拖动 → 底部吸附 (372,746,dock:bottom)（= 826−56−24 精确公式） | ✓ |
| 拖动 → 右侧吸附 (792,372,dock:right)（= 872−56−24） | ✓ |
| 吸附动画（.pk-orb-snapping 过渡后落位） | ✓ |
| localStorage `pk-float:orb-pos` 持久化 + reload 恢复 | ✓ |
| hover 双通道（data-state + class）| ✓ |
| 纯净标签页（无合成事件）展开/收起循环 | ✓ console 0 错误 |

### 5.4 响应式抽查（4 尺寸 · `review/3d-rc1/responsive.html` iframe 加载真实 `/`）

| Viewport | Orb 尺寸 | Glyph | 水平溢出 |
|----------|----------|-------|---------|
| 1280×900 | 56px | 24px | 无 |
| 1024×768 | 56px | 24px | 无 |
| 768×1024 | 56px | 24px | 无 |
| 375×667 | **48px** | **20px** | 无 |

### 5.5 FROZEN 审计

PowerShell SHA256 replay against `reports/frozen-baseline-3c3b.txt`:

```
checked=47 mismatch=0
```

`server/**`（含 `server/ai/skills/intent-compiler/**`）、`tests/fixtures/**`、`src/models/prompt.js`、`src/models/version.js` — **0 修改**。FROZEN CHANGE REQUEST REQUIRED: **NO**。

---

## 6. Known Limitations（如实记录）

1. **listening / processing 的真机激活场景** — 状态管道由 store 订阅驱动、单测全覆盖（ORB-STATE-01..08），但本轮 headless E2E 无麦克风（Voice 无法真实启动），且 REAL 传输 REFINE 周期 < 采样间隔（150ms）未能截获 processing 视觉帧。RC2 在移动真机 + 慢网络下补录激活证据。
2. **Quick Menu / 双击 / 长按** — 仅预留事件通道与 RC2 注释（主 Prompt §3.4 禁止本阶段实现 UI）。
3. **后台标签 0×0 viewport clamp** — 自动化环境以后台标签打开页面时 viewport 为 0，Orb 恢复被 clamp 到 (8,8)。真实浏览器后台标签具有真实视口，不触发此路径；属测试环境伪影，记录备查。
4. **合成指针事件** — E2E 拖动用合成 PointerEvent 驱动，控制台出现一条良性 `setPointerCapture NotFoundError`（合成 pointerId 无活动指针）；真实输入路径不触发，非产品缺陷。
5. **Orb 拖动用 left/top 而非 transform** — 沿用主 Float 既有拖动模式（一致性优先）；性能快检确认无 long task，RC2 若需进一步优化可改 transform。

---

## 7. Final Verdict

```
PHASE 3D — RC1 · PROMPTKEY ORB + RELEASE CANDIDATE
===================================================
Baseline tests:  346/346 PASS (+30 this phase)
Lint:            PASS
Build:           PASS (54 files)
FROZEN:          47/47 files, 0 changes (SHA256 replay)

GATE A (Orb 品牌):    PASS
GATE B (Orb 交互):    PASS — 28/28 单测 + E2E 拖动/吸附/持久化
GATE C (状态管道):    PASS — 优先级契约 + hover 双通道 E2E
GATE D (RC1 收尾):    PASS — 错误矩阵 10/10 · lint PASS · longTasks=0
GATE E (全量回归):    PASS — 核心旅程 · 4 尺寸响应式 · console 0 SEVERE
Browser E2E:          PASS
```

**PHASE 3D-RC1 — PASS**

Next recommended phase: **3E — 官网嵌入 + Mobile 真机 E2E + Pre-release QA**（Orb listening/processing 真机激活证据在此阶段补录）。
