# PHASE 3C-3A — PROMPT COMPOSER WORKSPACE
# 产品需求文档（PRD）

> 状态：**DRAFT — 等待小默 APPROVED**
> 前置：PHASE 3C-2B FINAL PASS（2026-08-31），git 基线 `v0.3.2-3c2b`
> 纪律：本文档 APPROVED 之前不写任何实现代码。

---

## 0. 一句话定位

> 把 Composer 从"一次性输入框"升级为"Prompt 工作台"：用户的草稿永不丢失、编辑永远可撤销、当前状态一眼可读。

## 1. 背景与问题

3C-2B 完成了 Composer / Voice / Creative Inbox 三者协同，核心闭环已可用。但对照 3C-3A 的产品标准，当前 Composer 仍是"输入框"而非"工作台"，具体缺口（全部经代码查证）：

| # | 缺口 | 现状证据 |
|---|------|----------|
| G1 | **草稿不持久化** | `main.js` 启动只恢复浮窗位置/状态（`restoreFloat()`）；`persistSession()` 只在 AI 结构化之后保存 session。用户输入到一半刷新页面 / 关闭浏览器，Composer 内容全部丢失 |
| G2 | **无 Undo/Redo** | 全代码库无 undo/redo 实现（`version.js` 的 original/optimized 是"版本对比"概念，不是编辑撤销）。更关键：Voice 追加、Inbox ADD、Thought USE 都是程序化重写 textarea，会破坏浏览器原生撤销栈——原生 Ctrl+Z 在本产品不可靠 |
| G3 | **无当前状态指示** | 用户无法一眼回答："我现在的草稿存了吗？这段内容是从哪来的（我打的/语音的/取回的 Thought）？现在处于什么阶段？" |
| G4 | **插入语义不一致** | Voice 停止 = **追加**（空则置入，否则拼接）；Inbox ADD = **追加**；Thought USE = **整体替换**（`updateInput(trimmed)`）。三种"进入 Composer"的路径行为不统一，用户无法建立稳定心智模型 |

## 2. 目标 / 非目标

### 目标（本 Sprint 交付）
1. **Draft Persistence** — Composer 草稿与 Inbox 捕获框草稿自动保存、自动恢复
2. **Undo/Redo** — 应用层编辑历史（含光标位置），键盘 + 按钮双入口
3. **Composer 状态指示** — 草稿来源与保存状态的可视化
4. **插入语义统一** — 三条进入 Composer 的路径行为一致且可预期

### 非目标（明确排除，防止范围蔓延）
- ❌ 六字段 Prompt Structure 可视化编辑 —— 属 **3C-3B**
- ❌ 多 Thought 组合成 Prompt Context —— 属 **3C-3C**
- ❌ Prompt Intelligence / Skill 任何改动 —— **Skill v1.1 FROZEN**，UI 承接属 3C-3D
- ❌ Delivery 多目标（Open ChatGPT/Claude/Gemini）—— 属 **3C-3E**
- ❌ 视觉/动效 Polish —— 属 **Phase 4**
- ❌ 数据流改动 —— Capture→Compose→Refine→Collect→Reuse→Generate 铁律不动
- ❌ prompt.js 六字段 schema 改动 —— schema 冻结

## 3. 固定产品语义（本 PRD 的设计边界）

以下 3C-2B 已定语义**只做兼容、不做破坏**：

1. Voice 是纯输入：interim 只预览，final 追加进 Composer，永不自动触发 AI
2. REFINE 是 Creative Inbox 的唯一入口，REFINE 不消耗 Composer 内容
3. USE 取回 Thought 后**不自动提交**，用户保持完全控制
4. CLOSE 是浮窗层拆除（终止语音、清错误），**不是数据抹除**——重开浮窗从干净交互态开始
5. Escape = 取消语音；Enter = 确认发送（Shift+Enter 换行）

## 4. 功能需求

### FR-1 Draft Persistence（草稿持久化）

**用户故事**：我在 Composer 里打了 200 字，手滑刷新了页面（或合上电脑明天再开）——重新打开 PromptKey，我的 200 字还在，光标可继续编辑。

规则：
- **R1.1 保存范围**：Composer 输入内容 + Inbox 捕获框（draft）内容 + Inbox 展开态。**不保存**：语音状态、错误状态、AI 处理中间态（重开一律从干净的 idle 开始——与 3C-2B Bug#10 语义一致）
- **R1.2 保存时机**：停止输入 500ms 后自动保存；页面隐藏（`visibilitychange`）与关闭前（`beforeunload`）强制落盘
- **R1.3 恢复时机**：启动即恢复；恢复后处于可编辑状态（有内容 → input 态；无内容 → idle 态）
- **R1.4 清除时机**：① 发送成功（prompt 已交付，工作台清场）② 用户点 NEW（显式重启）。**清除即删存储，不是置空内存**
- **R1.5 失败静默**：隐私模式 / 存储配额满 → 静默降级（不弹错、不阻塞输入），状态指示显示"未保存"而非报错
- **R1.6 本地性**：草稿只存 localStorage，不上服务器、不进后端日志
- **R1.7 版本化**：存储带 schema 版本号，未来格式变更可迁移

### FR-2 Undo / Redo（编辑历史）

**用户故事**：我按了 USE 把一个 Thought 取回来，发现不如我原来打的内容好——Ctrl+Z 一步回到取回之前，我的原稿和光标位置原样恢复。

规则：
- **R2.1 应用层实现**（架构决策，理由见 TECH-SPEC §2）：不依赖浏览器原生 textarea 撤销（会被程序化写入破坏）
- **R2.2 快照内容**：文本 + 光标位置（selStart/selEnd），撤销后光标回快照位置
- **R2.3 合并策略**：连续打字（间隔 < 400ms）合并为一步；程序化修改（Voice final 追加 / Inbox ADD / Thought USE / Undo 自身重做）**强制分步**，保证"一次程序化操作 = 一次可撤销单元"
- **R2.4 快捷键**：Ctrl+Z 撤销；Ctrl+Shift+Z 或 Ctrl+Y 重做（textarea 内拦截原生行为）
- **R2.5 按钮入口**：Composer 工具区提供撤销/重做按钮（移动端无键盘的唯一入口）；不可用时置灰
- **R2.6 边界**：撤销栈空时 Ctrl+Z 无操作；新用户输入清空重做栈（标准编辑器语义）；栈上限 100 步（超出丢弃最旧）
- **R2.7 允许状态**：仅在 idle / input / editing 态可用；语音 listening/processing、AI understanding/structuring/improving/rewriting 期间禁用（避免与请求竞态）
- **R2.8 范围边界**：v1 只覆盖 **Composer 主输入区**。Inbox 捕获框与 Thought 编辑的撤销属 3C-3C，不做

### FR-3 Composer 状态指示

**用户故事**：我扫一眼 Composer 顶部就知道——现在是空草稿还是已有内容？内容来源是什么？存没存？

规则（单一状态徽章 + 保存点，不堆叠多个控件，遵守"VOICE/REFINE 两键克制"哲学）：
- **R3.1 来源标记**（推导自最近一次内容修改路径）：
  - `EMPTY` 空
  - `DRAFT` 用户键入
  - `DRAFT · VOICE` 含语音追加（本轮会话内）
  - `DRAFT · THOUGHT` 经 USE 取回
- **R3.2 保存指示**：自动保存成功后显示低调的 `SAVED`；未保存/保存失败显示 `UNSAVED`（不闪报错）
- **R3.3 处理中**：AI 处理期间徽章让位于既有的 processing 表现，不新增第二套 loading
- **R3.4 克制原则**：徽章为 11-12px 单行文字或极小圆点 + 文字，无动画、无彩色堆叠（视觉语言留给 Phase 4）

### FR-4 插入语义统一（保守版）

- **R4.1 统一规则**：所有"外部内容进入 Composer"的路径，行为 = **置入（空时）/ 追加（非空时，以空格连接）**，并在追加后保持可撤销（见 R2.3）
- **R4.2 USE 语义变更**：由"整体替换"改为"置入/追加"。**注意**：这是对 3C-2B 已验收行为的语义修正，理由：替换会静默丢弃用户现有草稿，违背"工作台"定位（数据不应无声消失）
- **R4.3 不做**：真正的多段结构化内容管理（segments 模型）——那是 3C-3C（Thought → Prompt 组合）的范畴

## 5. 开放问题（需小默在 APPROVE 时裁决）

| # | 问题 | 默认建议 |
|---|------|----------|
| Q1 | R4.2 USE 从"替换"改"追加"是否同意？（若你更倾向保留替换语义，可改为"替换前自动将原稿压入撤销栈"，即替换可撤销但默认行为不变） | **建议改为追加**（与其他两条路径一致） |
| Q2 | 发送成功后草稿自动清除（R1.4①）是否同意？还是发送后也保留草稿？ | **建议自动清除**（工作台清场，进入下一个想法） |
| Q3 | 撤销/重做按钮是否需要，还是 v1 只做快捷键（移动端延后）？ | **建议带按钮**（移动端唯一入口） |
| Q4 | Inbox 捕获框草稿要不要持久化（R1.1 含）？ | **建议含**（成本极低，价值明确） |

## 6. 验收标准（Definition of Done）

### 6.1 单元/集成测试
- 新增测试预计 30–40 个（历史栈纯函数、draft 持久化、boot 恢复、状态推导 selector、插入语义）
- **既有 204 个测试零回归**

### 6.2 浏览器 E2E（逐条实测，不接受"应该没问题"）
1. 输入 200 字 → 刷新页面 → 草稿完整恢复、可继续编辑
2. 输入 → 关浮窗 → 重开 → 草稿恢复；语音/错误状态干净（3C-2B 语义不破坏）
3. 键入若干 → Voice 追加一段 → Ctrl+Z → 精确回到追加前（含光标）
4. USE 取回 Thought → Ctrl+Z → 原 Composer 草稿恢复
5. 连续打字 10 秒 → 单次 Ctrl+Z 只撤一步（合并生效）
6. Ctrl+Z 到底 → 置灰；打字后重做栈清空
7. 发送成功 → 草稿清除（存储层也删）
8. NEW → 草稿清除
9. 状态徽章：EMPTY/DRAFT/DRAFT·VOICE/DRAFT·THOUGHT/SAVED/UNSAVED 各态实测
10. 隐私模拟（localStorage 不可写）→ 输入不阻塞、显示 UNSAVED
11. 回归：Voice 三轮、REFINE→Inbox、Inbox 编辑/删除、Submit 全链路不回归

### 6.3 铁律检查
- FROZEN 集零改动（server/**、intent-compiler、golden fixtures、prompt.js schema）
- 数据流不变（一条不增不删）
- renderer 仍是唯一 DOM 写入口
- 交付时打 git tag，交付审计用 git diff

## 7. 交付物

1. 实现代码 + 测试（`node --test` 全绿）
2. `PHASE-3C-3A-DELIVERY-REPORT.md`（含 E2E 截图证据、FROZEN check、测试统计）
3. git commit + tag
4. 等小默二次验收（Release Gate）

---

**APPROVED 签字栏**：小默 ______（批准 / 有修改意见 / 驳回）
