# PHASE 3C-2B — PRE-IMPLEMENTATION REPORT（Rev 2）

- **Phase**: 3C-2B（Creative Inbox ↔ 主 Prompt Composer 协同改造）
- **Status**: **AWAITING APPROVAL**（§66 硬约束：未获 "APPROVED" 前不改任何代码）
- **Date**: 2026-08-31（Rev 2：并入小默产品验收反馈 10 项）
- **Spec anchor**: §65（本报告格式 12 节）/ §66（STOP 等 APPROVED）
- **RULE 1 完成**: 已通读 21+ 个资料文件（见 §4 清单）
- **Rev 2 修订说明**: 本版并入小默 2026-08-31 产品验收 10 项反馈——①Composer 持续编辑；②VOICE 多轮复用；③Voice+Composer 连续输入；④Inbox 唯一合法入口=REFINE；⑤Inbox 编辑/删除验收；⑥Joystick 删除（保留底层 action）；⑦底部实体控制=VOICE/REFINE（删除 SEND 实体键）；⑧Inbox 卡片 USE；⑨19 步完整链路验收；⑩核心交互模型=数据流。

---

## 1. 阶段目标（Spec 意图 + 核心交互模型）

### 1.1 核心交互模型（Phase 3C-2B 的数据流锚点）——验收反馈 ⑩

> **本阶段目标不是简单"把 Inbox 移位置 + 改几个按钮"。真正的目标是建立一条清晰、唯一、可反复循环的数据流。**

```
                        ┌────────────────────────────────────────────┐
                        │           PHASE 3C-2B 核心数据流            │
                        └────────────────────────────────────────────┘

   USER INPUT ───────────────────────────────────────────────────────────┐
   （键盘文字 / VOICE 语音）                                              │
        │                                                               │
        ▼                                                               │
   COMPOSER（state.input）── 始终可编辑的用户草稿 ──┐                     │
        │                                        │                     │
        │  USER EDIT（追加 / 删除 / 修改）          │ 可循环：编辑→再输入→再编辑 │
        │                                        ▼                     │
        │                        再次 VOICE → 内容并入 Composer          │
        │                                        │                     │
        ▼                                        │                     │
   REFINE（用户显式点击 = 唯一加工入口）◄────────────┘                    │
        │  AI PROCESSING（analyze/refine）                              │
        ▼  成功                                                         │
   AI PROCESSED THOUGHT ────────────────────────────────────────────────┘
        │
        ▼
   CREATIVE INBOX（唯一合法入口 = REFINE 成功；只装 AI 处理后内容）
        │
        ├─ EDIT   （修改 AI 后文本，保存保持）
        ├─ DELETE （删除 Thought，不影响 Composer）
        └─ USE    （取回 → Composer / Prompt Pipeline）
                 │
                 ▼
        COMPOSER / PROMPT PIPELINE → 最终提交
```

**三条铁律（贯穿本阶段所有改动）：**
1. **Voice = 输入**，不是"一次性生成一个不可编辑 Thought"。Voice 只负责把内容送进 Composer；生成 Thought 是 REFINE 的事。
2. **Creative Inbox 唯一合法入口 = REFINE 成功**。Voice stop、普通文字输入均**不得**自动创建 Inbox Thought。
3. **USE = 取回**（把 AI-processed Thought 取回 Composer / Prompt Pipeline），不是转发。

### 1.2 阶段目标清单（9 项，覆盖验收反馈全部）

1. **Composer 持续编辑**（验收 ①③）：`state.input` 始终可编辑；Voice stop 后进入 Composer 的文本继续可编辑；可在已有文本上追加/删除/修改；编辑过程中不被 state/render/voice lifecycle 覆盖、清空或失焦；AI REFINE 前 Composer 内容始终是用户可编辑草稿。
2. **Voice 生命周期多轮复用**（验收 ②）：VOICE 可反复启动/停止（第一/二/三……轮均正常）；一轮 stop 后进入完全可再启动状态，不得出现"一次使用后不可恢复"；user stop 与 pause 自动重启严格区分。
3. **Voice + Composer 连续输入**（验收 ③）：完整链路 = VOICE → Composer → 用户编辑 → 再次 VOICE → Composer → 继续编辑 → REFINE。Voice 不得绕过 Composer 直接创建 Inbox Thought。
4. **Inbox 唯一合法入口**（验收 ④）：Inbox 内容必须是 AI REFINE/ANALYZE 处理后内容；仅 `Composer → 用户显式 REFINE → AI 成功` 可创建 Inbox Thought。
5. **Inbox 编辑 / 删除完备**（验收 ⑤）：Thought 可编辑、可改 AI 后文本、保存后保持；可删除、删除不影响 Composer；编辑一个不破坏其他；render/update 不覆盖正在编辑内容。
6. **删除 Joystick**（验收 ⑥）：删 DOM/CSS/事件绑定，保留底层 state action（MOVE_SECTION / START_EDIT）不破坏架构能力。
7. **底部实体控制 = VOICE / REFINE 双键**（验收 ⑦）：底部永久实体控制**只保留 VOICE / REFINE**；删除独立 SEND / CONFIRM & SEND 实体键；`#pk-confirm` 若职责为 CONFIRM & SEND 则移除/重构，**不得保留功能意义不清晰的 SEND 实体键**。
8. **Inbox 卡片操作 = USE**（验收 ⑧）：`USE` 替代 `SEND TO PROMPT →`；语义 = 将 AI-processed Thought 取回 Composer / Prompt Pipeline。
9. **显式 userStopped 语义 + rocker 遮罩重构**（原规格 §7/§28/§29）：flow/machine 层补显式 user stop 检测；Inbox 上移 Composer 上方 + list 独立滚动。

> 一句话：**Voice 只负责"输入"→ 内容永远留在可编辑的 Composer → 用户编辑 → REFINE 是唯一"AI 加工入口"→ 加工成功才进 Creative Inbox → Inbox 支持编辑/删除/USE 取回 → 最终提交。**

---

## 2. 现状基线（改动前门禁实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | ✅ **172/172**（inbox 22 + voice-loop + 既有全部） |
| Lint | `npm run lint` | ✅ 前端/后端护栏成立（DOM 仅在 ui/+main.js，env 仅在 config/env.js，无 secret） |
| Build | `npm run build` | ✅ dist/ 重建成功（含 smoke-import） |
| Benchmark | 既有 `reports/prompt-intelligence/benchmark-v1.json` | ✅ 99.1% / 50P / 0C / 0F（Skill v1.1 FROZEN，本次零触碰） |

**3C-2B 将新增/修改测试，完成后测试数 > 172；FROZEN 集（Skill/Golden/benchmark）保持零改动。**

---

## 3. 关键差距（现状 vs 3C-2B 规格 + 产品验收反馈）—— 11 项

| # | 规格/反馈 | 现状（已读源码证据） | 要求 | 差距 |
|---|---|---|---|---|
| 1 | §9/§10/§19 + 反馈④ | `machine.js` L159-173：`VOICE_ENDED` → `createThought(draft,"voice")` 入 inbox；`prompt-flow.js` L166-183 onEnd 直接提交 inbox | 语音 stop → 内容**留 Composer**（`state.input`），**不**自动落 inbox；Inbox 唯一入口 = REFINE 成功 | ⚠️ 行为相反 |
| 2 | §5 + 反馈⑩ | `index.html` L122-141：`#pk-inbox` 在 workspace 底部；`css` `.pk-inbox` 常驻底部 | Inbox 移至 **Composer 上方**（输入区与想法区同屏） | ⚠️ 位置不符 |
| 3 | §31 + 反馈⑥ | `index.html` L148-157 `#pk-joystick`；`css` L395-419；`main.js` L84-107 事件绑定 | **移除 Joystick**；保留底层 `MOVE_SECTION`/`START_EDIT` action | ⚠️ 需 REMOVE |
| 4 | §32 + 反馈⑦ | `index.html` L175-180 `#pk-confirm`（190×58，职责 = submitThought / CONFIRM & SEND）；`css` L468-482 | 底部实体控制**只保留 VOICE / REFINE**；删除独立 SEND / CONFIRM & SEND 实体键；`#pk-confirm` 移除/重构 | ⚠️ 需重构（含 SEND 移除） |
| 5 | §19 + 反馈⑧ | `renderer.js` L344：inbox 卡片 `SEND TO PROMPT →` → `sendThoughtToPrompt` | 改 **USE**（语义 = 取回 Composer / Prompt Pipeline） | ⚠️ 文案/语义 |
| 6 | §28/§29 | `css` L75 `#pk-float` 高 520px；L314 inbox list `max-height:236px`；workspace 单滚动 | inbox list **独立滚动区**，与 Composer 互不挤压；rocker 遮罩重构 | ⚠️ 布局 |
| 7 | §7 + 反馈② | provider 层已实现 pause 自动 restart（§7 大体满足），但 flow/machine 层**无显式 userStopped=false 检测** | flow/machine 层补显式 `userStopped` 语义：pause 自动重启 ≠ user stop；仅 user stop 触发"留 Composer" | ⚠️ 缺显式层 |
| 8 | **反馈①（真实 Bug）** | **Composer 持续编辑**：`state.input` 名义上可编辑，但用户实测"输入一段文本后无法稳定再修改/追加/删除/重新输入" | ①`state.input` 始终可编辑；②Voice stop 后文本继续可编辑；③可追加/删除/修改既有内容；④编辑过程不被 state/render/voice lifecycle 覆盖、清空或失焦；⑤REFINE 前始终是用户可编辑草稿 | ⚠️ **真实 Bug，需 RULE 2 定位根因**（疑点：renderer 每次 render 重写 `input.value` / 焦点与选区管理 / voice 提交路径） |
| 9 | **反馈②（真实 Bug）** | **VOICE 多轮复用**：`voiceSession` 计数器用于杀 stale onEnd 链（3C-1），但用户实测"第一次 VOICE 正常，stop 后第二次基本失效" | Voice lifecycle 可多轮重复启动/停止；一轮 stop 后进入完全可再启动状态，不得一次使用后不可恢复；专项测试 first/second/third session、stop→restart→stop、user stop 与 pause auto-restart 不混淆 | ⚠️ **真实 Bug，需 RULE 2 定位根因**（疑点：stop 后 voice 相关 state/transcript/draft 复位不完整 / provider restart 残留 / userStopped 标志未逐轮独立） |
| 10 | 反馈④ | 3C-2A 存在**文本捕获 ADD → inbox** 路径（原始文本直接入 inbox，未经 AI） | **Inbox 唯一入口 = Composer → 显式 REFINE → AI 成功**；普通文字输入/Voice stop 不得自动进 inbox；3C-2A ADD 路径需重新定位（见 §5.1 决策点） | ⚠️ 入口需收紧 |
| 11 | 反馈⑤ | 已有 `renderer.startThoughtEdit`/`editingThoughtId` 守卫/`_listKey` 缓存（3C-2A），但无明确验收与专项测试 | Inbox Thought 可编辑、改 AI 后文本、保存保持、可删除、删除不影响 Composer、编辑一个不破坏其他、render/update 不覆盖编辑中内容 | ⚠️ 验收/测试待补 |

> **注**：#8/#9 为用户实测真实 Bug，本次 RULE 2（实施）第一步须**先复现并定位根因**，再按 §5 方案修复——不允许"改了个按钮就交付"。

---

## 4. RULE 1 通读清单（证据）

**HTML/CSS**
- `index.html`（完整 DOM：views、Creative Inbox 容器、Physical Controls 含 Joystick/Send/Voice）
- `css/float.css`（tokens、workspace 布局、inbox 样式、delivered overlay、响应式）

**State 层**
- `src/state/machine.js`（interaction/window/voice 三切片 + inbox 独立切片 + `VOICE_ENDED`→inbox）
- `src/state/actions.js`（全部 action + ERR codes）
- `src/state/selectors.js`（含 `inboxThoughts`/`inboxCount`/`isInboxExpanded`/`canConfirm`）
- `src/state/store.js`

**Models**
- `src/models/thought.js`（`createThought`/`withOriginalText`/`withRefinedText`/`thoughtCopyText`/`thoughtPreview`）
- `src/models/prompt.js`（六字段 schema + `SECTION_ORDER`）
- `src/models/session.js`（`createSession`/`applyVersion`/`withSelection`）
- `src/models/version.js`（`createVersion`/`nextVersionNumber`）

**Flows / 入口 / 渲染**
- `src/flows/prompt-flow.js`（submitThought/toggleVoice/cancelVoice/bindVoiceCallbacks/addThoughtFromInbox/sendThoughtToPrompt/refineThought、reqSeq/stale、voiceSession）
- `src/main.js`（事件绑定、workspace 点击隔离、Joystick L84-107）
- `src/ui/renderer.js`（`renderInbox`/`startThoughtEdit`/`_listKey` 缓存/`editingThoughtId` 守卫）
- `src/ui/window-manager.js`（高度 fallback 440→520）

**Voice / AI / Delivery / Storage**
- `src/services/voice/interface.js`、`browser-provider.js`（continuous、pause 自动 restart、carryText、userStopped）
- `src/services/ai/interface.js`、`demo-provider.js`、`http-service.js`、`fallback-service.js`
- `src/services/delivery/interface.js`、`clipboard-provider.js`
- `src/services/storage/local-storage.js`

**报告 / 测试 / 门禁**
- `reports/3c-2a/PHASE-3C-2A-DELIVERY-REPORT.md`（§39 25 项，报告格式参照）
- `tests/voice-loop.test.js`、`tests/inbox.test.js`、`tests/machine.test.js`、`tests/flow.integration.test.js`、`tests/models.test.js`、`tests/helpers.js`
- `scripts/lint.js`、`scripts/build.js`（门禁规则）

> **RULE 2 需补充定位的根因点**（针对 #8/#9 真实 Bug）：renderer 对 Composer `input.value` 的写入时机与焦点/选区管理；voice stop→state 复位完整性（voiceDraft/transcript/session）；`voiceSession` 递增后各层读取是否一致。

---

## 5. 实施计划（MODIFY / ADD / DELETE / FROZEN 清单）

### 5.0 实施前置（RULE 2 第一步）：真实 Bug 根因定位

- **#8 Composer 持续编辑**：复现"输入→无法再编辑"→ 定位 renderer 是否每次 render 重写 `input.value`、是否触发失焦/光标丢失、voice 提交是否整体覆盖。
- **#9 VOICE 多轮复用**：复现"第二次 VOICE 失效"→ 定位 stop 后 voice state 是否完整复位（transcript/draft/userStopped）、provider 是否残留、`voiceSession` 是否造成死锁。
- 定位结论写入实施记录，再进入 §5.1 改动。

### 5.1 MODIFY（改动既有文件）

| 文件 | 改动点 |
|---|---|
| `src/state/machine.js` | ① `VOICE_ENDED` 改为：语音 final **写入 `state.input`（Composer）**，**不再** `createThought` 入 inbox；② **Inbox 唯一入口**：`createThought` 仅由 REFINE 成功路径触发；③ voice 生命周期：每次 stop 后**完整复位** voice 切片（transcript/draft/userStopped），支持多轮复用；④ 移除文本捕获 ADD→inbox 的直接入箱（若有） |
| `src/state/actions.js` | 补足所需 action：如 `VOICE_TO_COMPOSER`（voice 提交到 Composer）、REFINE 入箱 action、Inbox Thought 编辑/保存 action（若 3C-2A 未具名）；明确各 ERR 语义 |
| `src/state/selectors.js` | `canConfirm`/`customButtonsEnabled` 适配 REFINE 语义；新增（若需）`canRefine`/`inboxEditable` |
| `src/flows/prompt-flow.js` | ① `bindVoiceCallbacks` onEnd：**显式 `userStopped=false` 检测**（pause 自动重启不提交）；true 才 commit 到 Composer + showMessage；② **多轮复用**：每次 stop→start 完整重建 voice 会话（递增 session 号并确保各层读取一致、复位 draft/transcript）；③ 新增 `refineFromComposer()`：从 Composer 当前 `state.input` 走 AI → 成功创建 Inbox Thought（唯一入口）；④ `sendThoughtToPrompt` 语义对齐 **USE（取回）**；⑤ 确保 REFINE 前 Composer 内容永不被清空/覆盖 |
| `src/ui/renderer.js` | ① **Composer 编辑保护**：render 时若 input 值/焦点未变，**不得重写 `input.value`、不得夺焦/丢光标**（这是 #8 修复核心）；② Inbox 渲染位置移至 **Composer 上方**；③ 卡片按钮 `SEND TO PROMPT →` 改 **USE**；④ `_listKey`/`editingThoughtId` 守卫**保留并强化**：编辑中 Thought 不被 render 覆盖（#11）；⑤ 底部实体控制渲染为 **VOICE / REFINE 双键**（移除 SEND/CONFIRM & SEND） |
| `src/ui/window-manager.js` | 高度 fallback 520 → 新高度（依 §28/§29 布局 + Inbox 上移） |
| `index.html` | ① REMOVE `#pk-joystick`（L148-157）；② `#pk-inbox` 移到 **Composer 上方**；③ 底部控件重构为 **VOICE / REFINE 双键**，删除 `#pk-confirm`（SEND/CONFIRM & SEND）；④ inbox 卡片按钮文案 USE；⑤ 文本捕获 ADD 入口重新定位（见下方决策点） |
| `css/float.css` | ① 移除 joystick 样式（L395-419）；② 移除 confirm/send 样式（L468-482）→ 新增 VOICE/REFINE 双键样式；③ `#pk-float` 高度、Inbox 位置与 list **独立滚动**（L314 `max-height` 调整）；④ delivered overlay 适配；⑤ Composer 编辑态样式（无失焦闪烁） |

**决策点（实施前确认，默认按用户最严格表述）**：
- **3C-2A 文本捕获 ADD 路径**：按反馈④"普通文字输入不得自动进 inbox + Inbox 唯一入口 = REFINE 成功"，**默认改为**：ADD/捕获的原始文本**置入 Composer**（进入统一数据流），用户 REFINE 后才入 inbox；不再提供"原始文本直接入 inbox"路径。若小默希望 ADD 另有语义，请在 APPROVED 时指明。
- **Voice 提交到 Composer 的合并策略**：按反馈③⑨（"Composer 内容继续保持并可编辑" + 连续输入），**默认 = 在 Composer 当前内容基础上追加/合并，绝不整体清空既有内容**；若小默希望"第二次 voice 替换或按选区插入"，请在 APPROVED 时指明。
- **底部最终提交入口**：反馈⑦明确"最终 SEND/提交属于 Composer 的最终提交行为，不需要作为底部永久物理控制键"。**默认**：Composer 内保留最终提交动作（如键盘/Composer 内提交按钮），底部永久键只有 VOICE/REFINE。若小默希望 Composer 内也完全无 SEND 按钮，请在 APPROVED 时指明。

### 5.2 ADD（新增文件）

| 文件 | 内容 |
|---|---|
| `tests/3c-2b.test.js`（或按主题拆分） | **专项测试全覆盖**：①Composer 持续编辑（追加/删除/修改不被覆盖、不失焦——用焦点/值断言）；②Voice 多轮复用（**first/second/third session**、stop→restart→stop、user stop 与 pause auto-restart **不混淆**）；③Voice+Composer 连续输入（VOICE→Composer→编辑→再 VOICE→继续编辑→REFINE）；④Inbox 唯一入口（Voice stop/普通输入**不得**创建 Thought，仅 REFINE 成功创建）；⑤Inbox 编辑/删除（编辑保存保持、删除不影响 Composer、编辑一个不破坏其他、render 不覆盖编辑中内容）；⑥底部 VOICE/REFINE 双键 + 无 SEND 实体键；⑦USE 语义（取回 Composer/Prompt Pipeline）；⑧Joystick 移除后无引用（lint/构建门禁兜底）；⑨Inbox 上移 + 独立滚动渲染 |
| （实施后）`reports/3c-2b/PHASE-3C-2B-DELIVERY-REPORT.md` | 实施完成后交付报告（本次不产出，先等 APPROVED） |

### 5.3 DELETE（删除——小默已授权，确认安全直接删，不再逐个确认）

| 文件/位置 | 说明 |
|---|---|
| `index.html` L148-157（`#pk-joystick` DOM） | 规格 §31 + 反馈⑥ 移除 Joystick |
| `css/float.css` L395-419（joystick 样式） | 同上 |
| `main.js` L84-107（Joystick 事件绑定） | 同上（保留 `MOVE_SECTION`/`START_EDIT` action 本身） |
| `index.html` L175-180 `#pk-confirm`（CONFIRM & SEND 实体键） | 反馈⑦：移除 SEND/CONFIRM & SEND 实体键，底部只留 VOICE/REFINE |
| `css/float.css` L468-482（confirm/send 样式） | 同上 |
| 其他实施中确认无用的旧 DOM/CSS/测试残留 | 按小默授权直接删除，不弹确认 |

### 5.4 FROZEN（零改动，防回归）

| 集 | 理由 |
|---|---|
| `server/ai/skills/intent-compiler/**`（Skill v1.1） | 3B-3 FROZEN；本次仅前端协同改造，不动 Skill |
| `tests/fixtures/prompt-intelligence/**`（Golden Dataset） | 同上 |
| `scripts/benchmark*`、`reports/prompt-intelligence/**` | Benchmark 基线；不重跑不重算 |
| `server/**`（后端） | 3C-2B 无后端改动需求（REFINE 走既有 analyze 接口） |

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| **#8 Composer 编辑根因未知**（renderer 覆盖/失焦） | 高 | RULE 2 第一步先复现定位；修复 = renderer 不重写未变 input/不夺焦；新增焦点/值断言专项测试 |
| **#9 Voice 多轮复用根因未知**（stop 后不可再启动） | 高 | 复现定位 → 完整复位 voice 切片 + provider 重启；专项 first/second/third session + stop→restart→stop 测试 |
| Inbox 唯一入口收紧改变 3C-2A ADD 行为 | 中 | 明确决策点（§5.1）；按反馈④默认"原始文本入 Composer，REFINE 才入 inbox"；inbox.test.js 适配 |
| 语音 stop → Composer 改变 3C-1/3C-2A 既定行为 | 中 | 精准改 `VOICE_ENDED` + onEnd；重跑全部 172+ 测试；新增 3C-2B 专项测试 |
| `SEND TO PROMPT →` 改 `USE` 影响既有 inbox 测试 U/U2/Y | 中 | 保留函数，仅改文案/语义与触发点；测试适配 |
| 移除 SEND 实体键后"最终提交"入口清晰度 | 中 | 决策点明确：Composer 内保留最终提交；验收 19 步第 19 步覆盖"最终可正常提交" |
| Inbox 上移 + 独立滚动破坏 delivered overlay | 低 | 保留 delivered overlay 规则，微调定位；浏览器实测兜底 |
| `userStopped` 显式化引入双语义混淆 | 低 | 明确分层：provider 物理判定 / flow-machine 语义消费；接口注释对齐 |
| Joystick 移除后 `moveSection`/`startEdit` 依赖断裂 | 低 | 保留 state 层 action（触摸/后续版本可用），仅移除 DOM 控件 |

---

## 7. 与既有规格/架构的一致性

- **状态机架构**：仅改 `VOICE_ENDED` 分支、voice 切片复位、REFINE 入箱 action；不新增 interaction 态（Composer 停留 = 现有 `input` 态；多轮 voice 复用不引入新态，只保证复位）。
- **services 边界**：不新增服务；REFINE 复用 `ai.analyzePrompt`；语音仍走 `voice` 服务；Inbox 编辑/删除仍走本地 state（可沿用 storage 层）。
- **渲染边界**：DOM 写仍只在 `renderer.js`；事件绑定仍在 `main.js`；lint 护栏不破坏。
- **Demo First**：REFINE 走 demo provider（`OPTIMIZED ▸` 前缀），与 3C-2A 一致；real 模式走真实 DeepSeek。
- **无障碍**：底部 VOICE/REFINE 按钮保留 aria-label；Inbox 上移后 `aria-controls`/`aria-expanded` 保持同步。
- **核心数据流一致性**：所有改动必须保证 §1.1 数据流单向成立——INPUT→Composer→EDIT→REFINE→Inbox→EDIT/DELETE/USE→Pipeline，不允许任何旁路绕过 Composer 或未经 REFINE 入 inbox。

---

## 8. 验收标准（Definition of Done）

### 8.1 基础门禁（保持）
- [ ] 全部门禁：`npm test`（172 + 新增）全绿、`npm run lint` OK、`npm run build` OK
- [ ] FROZEN 集零改动（Skill/Golden/benchmark 文件 mtime 不变）

### 8.2 验收反馈 ①③ — Composer 持续编辑
- [ ] `state.input` 始终可编辑；Voice stop 后进入 Composer 的文本**继续可编辑**
- [ ] 用户可在已有文本基础上**追加**内容
- [ ] 用户可**删除、修改**已有内容
- [ ] 修改过程中**不因 state/render/voice lifecycle 导致 input 被覆盖、清空或失焦**
- [ ] AI REFINE 前，Composer 内容始终是用户可编辑草稿
- [ ] 专项测试：追加/删除/修改后值保持、焦点保持（焦点/值断言）

### 8.3 验收反馈 ② — VOICE 多轮复用
- [ ] VOICE→输入 A→stop→Composer 出现 A
- [ ] 再次 VOICE→输入 B→stop→Composer 可继续处理 B（内容保持可编辑）
- [ ] 再次 VOICE→输入 C→stop→仍然正常工作
- [ ] Voice lifecycle 可多轮重复启动/停止，**不得出现一次使用后不可恢复**
- [ ] 专项测试：voice first/second/third session、stop→restart→stop、user stop 与 pause auto-restart **不得混淆**

### 8.4 验收反馈 ④ — Creative Inbox 唯一合法入口
- [ ] Inbox 内容**必须**是 AI REFINE/ANALYZE 处理后内容
- [ ] **严格禁止**：Voice stop → 自动进入 Inbox；普通文字输入 → 自动进入 Inbox
- [ ] **仅** `Composer → 用户显式点击 REFINE → AI processing → 成功 → Creative Inbox` 可创建新 Inbox Thought
- [ ] 专项测试：Voice stop/普通输入后 inbox 无新增；REFINE 成功后 inbox 有新增

### 8.5 验收反馈 ⑤ — Inbox 编辑 / 删除
- [ ] Inbox Thought 可编辑；可修改 AI 生成后文本；**保存后修改保持**
- [ ] 可删除 Thought；**删除后不影响 Composer**
- [ ] 编辑一个 Thought **不破坏其他 Thought**
- [ ] render/update **不覆盖用户正在编辑的内容**
- [ ] 专项测试：编辑保存保持、删除不影响 Composer、多 Thought 隔离、编辑中不被 render 覆盖

### 8.6 验收反馈 ⑥ — Joystick 删除
- [ ] `#pk-joystick` DOM / joystick CSS / joystick 事件绑定**完全移除**，无残留引用（lint/build 兜底）
- [ ] 底层 state action（MOVE_SECTION / START_EDIT）**保留**，不破坏架构能力

### 8.7 验收反馈 ⑦ — 底部实体控制
- [ ] 底部永久实体控制**只保留 VOICE / REFINE 双键**
- [ ] 独立 SEND / CONFIRM & SEND 实体键**已删除**；`#pk-confirm` 移除/重构，**无功能意义不清晰的 SEND 实体键**
- [ ] VOICE=输入、REFINE=AI 加工、USE=Inbox 取用、最终提交属 Composer 行为——职责清晰

### 8.8 验收反馈 ⑧ — Inbox 卡片 USE
- [ ] `USE` 替代 `SEND TO PROMPT →`
- [ ] USE 语义 = 将该 AI-processed Thought **取回 Composer / Prompt Pipeline**

### 8.9 验收反馈 ⑨ — 完整用户链路（19 步实测）
- [ ] ①用户点击 VOICE → ②输入内容 → ③stop → ④内容进入 Composer
- [ ] ⑤用户手动修改 Composer → ⑥再次点击 VOICE → ⑦再输入内容 → ⑧stop → ⑨Composer 内容**继续保持并可编辑**
- [ ] ⑩点击 REFINE → ⑪AI 对 Composer 当前内容处理 → ⑫AI 成功后创建 Inbox Thought
- [ ] ⑬Inbox 位于 Composer 上方 → ⑭Inbox 独立滚动
- [ ] ⑮用户可以编辑 Inbox Thought → ⑯可以删除 Inbox Thought
- [ ] ⑰用户点击 USE → ⑱Thought 回到 Composer / Prompt Pipeline
- [ ] ⑲最终可以正常提交
- [ ] 浏览器实测（agent-browser @ 127.0.0.1:8765）19 步全链路走通

### 8.10 验收反馈 ⑩ — 核心数据流成立
- [ ] §1.1 数据流单向成立：USER INPUT → COMPOSER → USER EDIT → REFINE → AI PROCESSED THOUGHT → CREATIVE INBOX → EDIT/DELETE/USE → COMPOSER/PROMPT PIPELINE
- [ ] 无任何旁路绕过 Composer 或未经 REFINE 入 inbox

---

## 9. 交付物（本次阶段产出）

本次（PRE-IMPLEMENTATION 阶段）交付物仅为：
- 本报告 `reports/3c-2b/PHASE-3C-2B-PRE-IMPLEMENTATION-REPORT.md`（Rev 2，并入产品验收 10 项）

实施获批后将追加：
- 代码变更（见 §5.1-5.3）
- 新增测试（见 §5.2）
- `reports/3c-2b/PHASE-3C-2B-DELIVERY-REPORT.md`

---

## 10. 下一步（等 APPROVED）

1. 待小默审核本报告（Rev 2）并回复 **"APPROVED"**
2. 未获 APPROVED 前**不改任何代码**（§66 硬约束）
3. 获批后：**先复现定位 #8/#9 真实 Bug 根因** → 按 §5 实施 → 写专项测试 → 跑全部门禁 → 浏览器 19 步实测 → 输出 DELIVERY REPORT

---

## 11. 结论

**PHASE 3C-2B 处于 AWAITING APPROVAL（Rev 2）。** 本版已完整并入小默产品验收 10 项反馈：核心交互模型（§1.1 数据流）、2 个真实 Bug 差距（§3 #8/#9）、Inbox 唯一入口、Inbox 编辑/删除验收、底部 VOICE/REFINE 双键（删除 SEND 实体键）、USE 语义、19 步完整链路验收（§8.9）。RULE 1 已完成（21+ 文件 + 基线门禁 172/172/lint/build 全绿）。实施计划（MODIFY/ADD/DELETE/FROZEN）已更新，风险与验收标准覆盖全部反馈项。

---

## 12. 备注（如实记录）

- 3C-2B 规格原文（§5/§9/§10/§19/§28/§29/§31/§32/§65/§66 等段落编号）来自小默在本对话中的规格描述，未落盘为独立文件；本报告依据对话摘要 + 源码现状 + **Rev 2 产品验收反馈 10 项**整理，若规格细节有出入，请小默在 APPROVED 时一并指正。
- **真实 Bug（#8/#9）为用户实测确认**，非代码推断；根因需在 RULE 2 第一步复现定位，本报告已列出疑点（renderer 写入/失焦、voice state 复位、voiceSession 一致性）。
- **删除授权**：小默已授权"确认无误可删的直接删除，不再逐个确认"——适用于 §5.3 全部删除项。
- **决策点**（§5.1）：3C-2A ADD 路径、Voice 提交合并策略、最终提交入口，默认按反馈最严格表述，请在 APPROVED 时确认或指正。
- 3C-2A 的"语音→inbox"行为（`VOICE_ENDED`→inbox）是本次规格要求改变的核心，改动将连带影响 `voice-loop.test.js` 与 `inbox.test.js` 的适配，已在 §6 风险中列出。
