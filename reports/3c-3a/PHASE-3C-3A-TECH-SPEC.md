# PHASE 3C-3A — PROMPT COMPOSER WORKSPACE
# 技术实施 Spec

> 状态：**DRAFT — 等待小默 APPROVED（随 PRD 一并批准）**
> 基线：git `v0.3.2-3c2b`（commit 0e7b714）。实施后交付审计以 `git diff v0.3.2-3c2b` 为准。

---

## 0. 现状事实（实施前提，全部经代码查证）

| 事实 | 证据 |
|------|------|
| Composer 输入经 `UPDATE_INPUT` 进 store，renderer 仅在值不同时回写 textarea（`renderer.js:441-442`） | 已有写保护，undo 渲染路径安全，但需补光标恢复 |
| Voice final = **追加**（`prompt-flow.js` onEnd → transcript 已并入 input）；Inbox ADD = **追加**（`addThoughtFromInbox` 拼接）；USE = **替换**（`sendThoughtToPrompt` → `updateInput(trimmed)`） | 三路径语义不一致（PRD G4） |
| `persistSession()` 只存 AI 结构化后的 session；无草稿存储、无"活跃会话指针"、boot 不加载任何 session | Draft persistence 缺失（PRD G1） |
| interaction 状态表：idle/input/understanding/structuring/review/editing/improving/rewriting/ready_to_send/sending/delivered（+error 表现） | undo 可用态白名单 = idle/input/editing |
| storage 层无 interface.js 断言（ai/voice/delivery 均有 `assert*Service`） | 补齐一致性（可选小项） |
| Escape 全局绑定 cancelVoice；textarea 无键盘拦截 | Ctrl+Z 需 preventDefault 覆盖原生 |
| 编辑快照需光标：`input` 事件可读取 `selectionStart/End`；程序化修改时 = 文本末尾 | 快照结构定义于 §2.2 |

## 1. 总体架构决策

### D1 — Undo/Redo 用应用层快照栈，不用浏览器原生撤销

理由（PRD R2.1 的技术依据）：
1. Voice final、Inbox ADD、USE 都会程序化重写 `textarea.value`，**每次重写都清空浏览器原生撤销栈**——原生 Ctrl+Z 在这些操作后直接失效或行为不可预期；
2. 我们需要"程序化操作 = 一个可撤销单元"的产品语义，原生栈做不到强制分步；
3. 快照栈可携带光标位置，可测试（纯函数），可持久化（为 3C-3C 扩展预留）。

### D2 — 历史栈作为 store 的一个新切片（`history`），不做成独立模块

与现有架构（interaction/window/voice 三切片 + 纯 reducer）同构：UNDO/REDO 是普通 action，走同一条 dispatch → machine → renderer 管线。**不引入新范式**。

### D3 — 草稿持久化扩展 StorageService 接口，不绕过

`saveDraft/loadDraft/clearDraft` 三个新方法，与 `saveSession/loadSession/clearSession` 对称。Demo/生产/云端 provider 未来可替换，flow 层不感知存储介质。

### D4 — 插入语义统一在 flow 层实现，不进 reducer

追加/置入逻辑（"空则置入，非空追加"）复用 `addThoughtFromInbox` 已验证的拼接模式，收敛为一个共享辅助函数；reducer 保持对 `UPDATE_INPUT` 一无所知（纯文本替换）。

---

## 2. 模块设计

### 2.1 新增 `src/state/history.js`（纯函数，零 DOM）

```text
createHistory(limit=100)
  → { stack: Snapshot[], index: -1, baseId }

Snapshot = { input: string, selStart: int, selEnd: int, at: number, kind: "user"|"program" }

pushUser(h, snapshot)   — 合并：与栈顶同为 kind="user" 且 at 差 < 400ms → 覆盖栈顶（重置其 at）
                         否则压栈；index 指向新顶；清空 index 之后的重做分支
pushProgram(h, snapshot)— 强制压栈（永不合并不覆盖），同样清重做分支
undo(h)   → { history, snapshot } | null   — index>0 才可用；index-=1；返回目标快照
redo(h)   → { history, snapshot } | null   — index<stack.length-1 才可用；index+=1
canUndo(h)/canRedo(h)   — 布尔（供置灰）
```

不变量（单测覆盖）：栈长 ≤ limit（超出丢最旧并平移 index）；任何时刻 `index ∈ [-1, stack.length-1]`；重做分支只被"新的 push"清除，不被"undo 到底"清除。

### 2.2 store / actions / machine 改动

**actions.js 新增：**
```text
RESTORE_DRAFT     { input, inboxDraft, inboxOpen }   — 仅 boot 恢复用
UNDO_INPUT        {}                                  — 机器守卫（见 2.3）
REDO_INPUT        {}
DRAFT_SAVED       { savedAt }                         — 保存回执（徽章 SAVED）
DRAFT_SAVE_FAILED {}                                  — 徽章 UNSAVED
```
**`UPDATE_INPUT` 增加可选 meta**：`{ source: "user" | "program" }`（默认 "user"）+ 可选 `sel`。reducer 在处理 UPDATE_INPUT 的同时调用 history 纯函数维护切片——**单 dispatch 原子完成**，不存在"文本更新了但历史没记"的中间态。

**machine.js：**
- `UNDO_INPUT` / `REDO_INPUT` 守卫：仅在 `idle | input | editing` 态接受；其他态静默忽略（不报错、不进 error）
- reducer 分支：从 history 取快照 → 写 `state.input` + `state.history.index`；RESTORE_DRAFT 分支：写 input/inbox 草稿，interaction 落到 `input`（有内容）或 `idle`（空）
- `DELIVERY_COMPLETE` / `NEW_THOUGHT` reducer 追加：重置 history 为空栈（工作台清场）

**selectors.js 新增：**
```text
canUndo(state) / canRedo(state)          — 供按钮置灰
composerStatus(state)                    — PRD R3 徽章推导：
   EMPTY（input 空）/ DRAFT / DRAFT·VOICE / DRAFT·THOUGHT
   （来源 = input.source 字段，UPDATE_INPUT meta 写入，随快照一起保存）
draftSavedState(state)                   — SAVED / UNSAVED
```

### 2.3 flow 层改动（`prompt-flow.js`）

```text
persistDraft()      — 防抖 500ms（delays 注入，测试瞬时）→ storage.saveDraft({
                        schema: 1, input, inputSource, inboxDraft, inboxOpen, savedAt })
                      → DRAFT_SAVED / DRAFT_SAVE_FAILED
flushDraft()        — 立即执行挂起的防抖（visibilitychange hidden / beforeunload 调用）
clearDraft()        — storage.clearDraft()（发送成功、NEW 时；与 history 重置同批触发）
placeIntoComposer(text, source)  — §D4 共享辅助：空则置入、非空追加（空格连接），
                        dispatch UPDATE_INPUT meta={source:"program"} —— USE/ADD 复用；
                        USE 从替换改为调用本函数（PRD R4.2，受 Q1 裁决约束）
```

**快捷键（main.js）**：textarea keydown 拦截 `Ctrl/Cmd+Z`（无 Shift → UNDO_INPUT；有 Shift → REDO_INPUT）、`Ctrl/Cmd+Y` → REDO_INPUT，`preventDefault()`。注意与现有 Enter/Escape 处理共存，不改它们。

**boot（main.js）**：`storage.loadDraft()` → 有内容则 dispatch `RESTORE_DRAFT`（在初始 render 之前）；`visibilitychange`/`beforeunload` → `flows.flushDraft()`。

### 2.4 renderer / css 改动

- 状态徽章：Composer 顶部一行（`composerStatus()` + `draftSavedState()`），纯文字/圆点，`css/float.css` 新增 ≤ 30 行样式（含窄屏适配）
- Undo/Redo 按钮：Composer 工具区两个小按钮（`canUndo/canRedo` 置灰）；点击 dispatch
- **光标恢复**：renderer 在回写 `input.value` 后（仅 UNDO/REDO 触发的变更），`setSelectionRange(selStart, selEnd)` 并仅在浮窗可见时 focus
- 其余渲染路径零改动（现有"值不同才写"守卫已覆盖）

### 2.5 storage 改动

`local-storage.js` 新增（复用现有 safeGet/safeSet/safeRemove）：
```text
DRAFT_KEY = "pk-float:draft"
saveDraft(draft)   — JSON.stringify（含 schema:1）
loadDraft()        — 解析 + schema 校验，损坏返回 null（静默丢弃，不报错）
clearDraft()       — safeRemove
```
新增 `src/services/storage/interface.js`：`assertStorageService`（对齐 ai/voice/delivery 的接口断言模式；main.js 接线处调用）。

---

## 3. 文件影响清单（git diff 审计对照用）

| 文件 | 改动 | 性质 |
|------|------|------|
| `src/state/history.js` | **新增** | 纯函数 |
| `src/services/storage/interface.js` | **新增** | 断言 |
| `src/state/actions.js` | +5 action，UPDATE_INPUT meta | 修改 |
| `src/state/machine.js` | +UNDO/REDO/RESTORE_DRAFT 分支，两处清场 | 修改（**FROZEN 敏感区相邻，须逐行 diff 审计**） |
| `src/state/selectors.js` | +4 selector | 修改 |
| `src/state/store.js` | 初始态 +history 切片 | 微改 |
| `src/flows/prompt-flow.js` | +persistDraft/flushDraft/clearDraft/placeIntoComposer；USE 改语义 | 修改 |
| `src/main.js` | boot 恢复、快捷键、生命周期 flush | 修改 |
| `src/ui/renderer.js` | 徽章、按钮、光标恢复 | 修改 |
| `css/float.css` | 徽章/按钮样式 | 追加 |
| `index.html` | 徽章/按钮 DOM 挂点 | 微改 |
| `tests/` | 新增 `history.test.js`、`draft-persistence.test.js`、`composer-status.test.js`、`insert-semantics.test.js`；更新受影响既有测试 | 新增/修改 |

**零改动承诺（FROZEN 集刚性约束）**：`server/**`、`src/ai` 相关 skill、`tests/fixtures/prompt-intelligence/**`、`src/models/prompt.js`（六字段 schema）、`src/models/version.js`（版本链语义）、`src/models/thought.js`、既有 voice 状态机语义（仅追加 undo 守卫，不改 4 态本身）。

## 4. 测试计划

**新增（预估 30–40 个）：**

| 组 | 覆盖 |
|----|------|
| history 纯函数（≈12） | 合并窗口、程序化强制分步、栈上限平移、undo/redo 边界、重做清除规则、不变量断言 |
| draft 持久化（≈8） | 防抖落盘、flush 立即、schema 损坏静默、隐私模式降级、发送/NEW 清除、boot 恢复三分支（有/无/损坏） |
| 状态推导（≈6） | composerStatus 四来源态、SAVED/UNSAVED、processing 让位 |
| 插入语义（≈5） | 置入/追加、USE 新语义、追加可一次撤销 |
| 机器守卫（≈4） | listening/understanding 等态 UNDO 被拒、editing 态允许 |

**回归要求**：既有 204 个零失败；`flow.integration.test.js` 中 USE 断言需按新语义更新（属预期变更，报告中单列说明）。

## 5. 实施顺序（内部门禁，逐段提交）

1. `history.js` + 纯函数测试（先测后接线）
2. actions/machine/selectors + 守卫测试
3. flow 层（persistDraft / placeIntoComposer / USE 语义）
4. storage 接口 + local-storage 扩展 + 持久化测试
5. renderer/css/index.html（徽章、按钮、光标恢复）
6. main.js 接线（boot 恢复、快捷键、生命周期）
7. 全量回归（test/lint/build）+ 浏览器 E2E（PRD §6.2 的 11 条）
8. FROZEN check（git diff 对照 §3 清单）→ DELIVERY REPORT → tag

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| UNDO dispatch 后 renderer 回写 textarea 触发 `input` 事件 → 误记入历史 | renderer 现有"值不同才写"守卫 + 程序化路径不发 meta.user；E2E #5 显式验证无循环 |
| 光标恢复在浮窗最小化时 focus 抢焦点 | 仅浮窗可见态 focus；E2E 覆盖 |
| 多标签页同 localStorage 写冲突 | last-write-wins，文档声明（v1 接受）；未来 schema 2 可加 tab id |
| beforeunload 中 async 写入可能被截断 | flushDraft 同步序列化 + localStorage.setItem 本身同步，绕开 async 包装（实现细节标注） |
| machine.js 处于 FROZEN 敏感区相邻 | 逐行 diff 审计进 Delivery Report；voice 4 态与 3C-2B 分支逐条比对 |

## 7. 明确不做（与 PRD 非目标对应）

segment 模型、六字段 UI、多 Thought 组合、Inbox Thought 编辑撤销、Skill 触碰、后端改动、动效。

---

**APPROVED 签字栏**：小默 ______（批准 / 有修改意见 / 驳回）
（Q1–Q4 开放问题的裁决请一并写入）
