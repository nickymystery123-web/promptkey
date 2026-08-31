# PROMPTKEY — P0 CORE ALIGNMENT AUDIT

**审计日期**: 2026-09-01
**审计性质**: 只读审计（READ-ONLY）。未修改任何代码、CSS、测试、FROZEN 文件。
**基线**: PHASE 3C-2B FINAL PASS（tag `v0.3.2-3c2b`，commit `0e7b714`）
**取证方式**: 逐文件通读源码（machine.js / prompt-flow.js / renderer.js / main.js / browser-provider.js / selectors.js / local-storage.js / clipboard-provider.js / fallback-service.js / http-service.js / thought.js）+ 19 个测试文件用例名核对 + CSS 行级核对 + git 工作树核对。
**工作树状态**: 代码零改动（`git status` 仅显示本报告与 3C-3A 文档为未跟踪新文件）。

---

## 1. Executive Summary

**总体结论：当前实现与 PromptKey 原始产品核心设想高度一致，无重大产品漂移（No Major Product Drift）。**

- **20 项 P0 核心能力中：17 项完整实现（REAL/PASS），2 项部分实现（PARTIAL），1 项按设计为 demo 层。**
- 核心链路 `Voice/Text → Composer → REFINE → AI → Creative Inbox → USE → Composer → Review → Submit` 与产品基线定义**逐环节吻合**，产品哲学 Capture → Compose → Refine → Collect → Reuse → Generate 完整成立。
- **3 项需要产品负责人裁决的事项**（详见 §14，均标记 PRODUCT DECISION REQUIRED）：
  1. **USE 语义不一致**：Voice 追加、Inbox ADD 追加，但 USE 是**替换**（replace）——三条"进入 Composer"的路径语义不统一，且 USE 替换会覆盖 Composer 已有未发送内容。
  2. **Submit 的投递通道是 demo stub**：状态流（confirm → ready_to_send → sending → delivered）真实，但 `deliver()` 不真正投递任何内容（不写剪贴板、不发送到任何目标）。实际复制只发生在 COPY 按钮。
  3. **断网静默回落 Demo 无 UI 提示**：后端不可达时自动切换本地 Demo Provider，界面无任何"当前是 Demo 模式"的指示，用户可能把模拟输出误认为真实 AI 输出。
- **1 项 P0 能力缺口**：Thought 持久化——页面会话内 Thought 全部保留（NEW_THOUGHT 不清 Inbox），但**刷新页面后 Creative Inbox 全部丢失**（storage 接口无 inbox API）。
- Draft Persistence / Undo / Redo / Status Badge 均为 **P1 / ENHANCEMENT**，全部**未实现**（与 3C-3A PRD 提案一致，见 §15）。

---

## 2. P0 Core Matrix

图例：状态 ✅ = 完整实现并测试；🟡 = 部分实现；测试列为关键证据（测试文件:用例）。

| # | P0 Core | 产品定义 | 当前代码实现 | 当前测试 | Browser E2E | 状态 | 风险 |
|---|---------|---------|-------------|---------|------------|------|------|
| 1 | Voice continuous input | 连续输入，停顿不结束 | `browser-provider.js` L79 `continuous=true`；停顿自动重启（L130-158，含实例守卫） | voice-loop: A, provider 暂停重启用例 | ✅ 3C-2B 验收 | ✅ | 低 |
| 2 | Voice explicit Stop | 用户主动 Stop 才结束 | `stop()` 置 `userStopped`，不再重启；`toggleVoice()` L190-192 | voice-loop: D, provider stop 用例 | ✅ | ✅ | 低 |
| 3 | Voice → Composer | 语音内容进 Composer，不静默覆盖 | machine.js L156-161：final "set if empty, else **append**"；`preVoiceInput` 快照供 cancel 恢复 | voice-loop: C/D; inbox: T; 3c-2b: C2 | ✅ | ✅ | 低 |
| 4 | Text → Composer | 打字输入 | `UPDATE_INPUT`（main.js L74-76）；Bug#8 修复后 caret 安全 | machine.test, 3c-2b: C1 | ✅ | ✅ | 低 |
| 5 | Composer editing | 持续编辑（增删改） | renderer.js L441-443 纯值比较镜像；`UPDATE_INPUT` reducer L286-292 | 3c-2b: C1; repro-bugs: #8/#8b | ✅ 19-Step | ✅ | 低 |
| 6 | Composer append 语义 | 程序化写入不丢用户内容 | Voice=append ✅；Inbox ADD=append ✅（flows L263）；**USE=replace**（flows L329 `updateInput(trimmed)`） | 3c-2b: B1 明确测为 replace | ✅ | 🟡 | **中 — DECISION REQUIRED** |
| 7 | REFINE | 显式触发 | 仅按钮/显式调用（main.js L87）；`canRefine` 门禁（selectors L93-103）；绝不自动 | 3c-2b: A1/E2/E3 | ✅ | ✅ | 低 |
| 8 | REFINE → Creative Inbox | 结果入 Inbox | `INBOX_ADD_REFINED` 是唯一入箱 action（machine L207）；originalText=用户原话快照，refinedText=AI 输出，分离存放 | inbox: E1/W/V | ✅ | ✅ | 低 |
| 9 | Thought persistence | Thought 跨会话保存 | **会话内保留**（NEW_THOUGHT 不清箱，machine L415-429）；**刷新即失**（storage 接口无 inbox API，`persistSession` 只存 session） | inbox: X（仅测会话内） | — | 🟡 | **中 — P0 缺口** |
| 10 | Thought edit | 可编辑 | `INBOX_EDIT` + renderer 内联 textarea（L370-407），就地重写 originalText，不碰其他 Thought | inbox: O; 3c-2b: D1/D2 | ✅ | ✅ | 低 |
| 11 | Thought delete | 可删除 | `INBOX_DELETE`（machine L233-243），同时清理展开标记 | inbox: P | ✅ | ✅ | 低 |
| 12 | Thought collapse/expand | 可展开/收缩 | `INBOX_TOGGLE_EXPANDED`；收缩预览 42 词 / 展开全文 | inbox: R | ✅ | ✅ | 低 |
| 13 | Thought long-text scrolling | 长文滚动 | `.pk-inbox-list` `max-height:236px; overflow-y:auto`（css L317）；卡片内全文展示 | inbox: R | ✅ 0/1/2/4 Thought 专项 | ✅ | 低 |
| 14 | USE | 如实报告（见 §8） | replace 语义，取 refined 优先、original 兜底，不自动 submit，Thought 不被消费 | 3c-2b: B1-B4; inbox: U/U2/Y | ✅ | ✅（语义待裁决） | 中 |
| 15 | USE → Composer / Pipeline | Thought 回 Composer 进管线 | `updateInput` → input 态 → `confirmAndSend` → AI 管线；`inputSource` 传递 Thought 来源 | inbox: U/U2/Z | ✅ USE→编辑→Submit | ✅ | 低 |
| 16 | Review | 提交前审阅 | review 态 + Original/Optimized 选择（`rawThought` 永不重构）+ 分区编辑 + C1/C2 | voice-loop: O/P/Q/R | ✅ | ✅ | 低 |
| 17 | Submit | Review 后可提交 | 状态流 confirm→ready→sending→delivered 真实；**`deliver()` 为 stub**（clipboard-provider L31-33，仅返回 prepared，无实际投递） | flow.integration: Confirm→Delivered | ✅ step19-delivered.png | 🟡 | **中 — 通道为 demo** |
| 18 | Voice error recovery | 错误可恢复 | error 态可重试（mic 再点）；CLOSE_FLOAT 全量复位；错误不阻塞 REFINE 兜底 | voice-error-reset: 1-4c | ✅ 专项 md | ✅ | 低 |
| 19 | Inbox scrolling | Inbox 内部滚动不挤压 Composer | `.pk-inbox` `max-height:55%`（css L273）+ body/list 内部滚动（L297/L317）；Float 视口自适应（L75） | — | ✅ 3C-2B Step6 专项（桌面+窄屏） | ✅ | 低 |
| 20 | Composer + Inbox coexistence | 共存不互相阻塞 | inbox 独立数据切片，本地操作零 AI 零异步（flows L252-256 注释 + 实现） | inbox: V | ✅ | ✅ | 低 |

**统计**：✅ 17 项 / 🟡 3 项（#6 USE 语义、#9 Thought 持久化、#17 Submit 通道）/ ❌ 0 项。

---

## 3. Current Data Flow（实测代码路径）

```
VOICE (Web Speech API, continuous + pause auto-restart)
   │ final transcript (set-if-empty / append)
TEXT (UPDATE_INPUT, caret-safe mirror)
   │
   ▼
COMPOSER (state.input — 用户工作台, 焦点/击键/程序化写入共存)
   │
   ├── REFINE (显式按钮) ──→ ai.analyzePrompt ──→ INBOX_ADD_REFINED ──→ CREATIVE INBOX
   │                                                              (originalText=用户原话,
   │                                                               refinedText=AI 输出)
   └── SUBMIT (#pk-submit / Enter)
        │
        ▼
   ai.analyzePrompt (understanding → structuring)
        │
        ▼
   PROMPT SESSION (六字段 schema, 版本链, selection: original|optimized)
        │
        ▼
   REVIEW (选择 / 分区编辑 / IMPROVE / REWRITE)
        │
        ▼
   CONFIRM → READY_TO_SEND → SENDING → DELIVERED
        (状态流真实; 投递通道 = demo stub, 实际复制走 COPY 按钮)
```

与产品基线定义的链路**逐环节一致**。唯一偏差：基线图中 "USE → Composer / Prompt Pipeline" 实现为 USE → Composer（手动 Submit 进管线），符合定义。

---

## 4. Voice Flow（实测）

| 产品要求 | 代码事实 | 结论 |
|---------|---------|------|
| 连续输入，停顿不结束 | `r.continuous = true`（L79）；浏览器段结束自动 `createRecognition()` 重启（L149-153）；携带已定稿基线不丢词 | ✅ |
| 用户主动 Stop 才结束 | `stop()` → `userStopped=true` → onend 不重启 → `endCb()` | ✅ |
| 停顿不触发任何 flow 动作 | onEnd 守卫 `!["listening","processing"].includes(voice)` 直接返回；暂停重启不达 flow 层 | ✅ |
| Voice 内容进入 Composer | final 逐字 append（machine L156-161）；interim 仅预览（`voiceTranscript`），**永不达 AI** | ✅ |
| 不静默覆盖已有内容 | append 合并；CANCEL 恢复 `preVoiceInput` 快照（machine L164-174） | ✅ |
| 不自动创建 Thought | `VOICE_ENDED` 注释+实现明确：Voice 是纯输入，入箱只走 REFINE | ✅ |
| 多轮复用 | VOICE_ENDED → idle，可立即再按 mic；三轮语音测试（3c-2b: C2/C3） | ✅ |

**Voice 语义 = append，未漂移。**

## 5. Composer Flow（实测）

- 输入/编辑/删除/清空：`UPDATE_INPUT` 全覆盖（3c-2b: C1）。
- 程序化写入共存：renderer 纯值比较镜像（L441-443），击键中不被覆盖（REPRO #8b），外部变更（voice final / USE 回填）同步到 DOM（REPRO #8）。
- **三条程序化进入路径的语义**：
  1. Voice final → **append** ✅
  2. Inbox ADD → **append**（flows L263 显式 merge）✅
  3. Thought USE → **replace**（flows L329 `updateInput(trimmed)` 直接整体替换）⚠️
- REFINE 不消耗 Composer 内容（捕获语义，flows L269-274 注释+实现）。
- 关闭浮窗保留草稿（machine CLOSE_FLOAT 注释 L108：input intentionally KEPT）。
- **未实现（P1）**：刷新页面草稿恢复、Undo/Redo、多段内容管理、状态徽章。

## 6. REFINE Flow（实测）

- **唯一触发方式**：用户点击 `#pk-refine` 按钮（main.js L87）。无任何自动触发路径。✅
- 门禁 `canRefine`（selectors L93-103）：空输入禁用；AI/发送进行中禁用；**仅 live voice（listening/processing）禁用**——error 是终态不阻塞（Bug #10 修复，兜底路径）。✅
- 流程：Composer 文本 → `ai.analyzePrompt` → 成功才 `INBOX_ADD_REFINED` + `INBOX_REFINE`。失败（含 Abort）→ toast "REFINE UNAVAILABLE"，**Composer 文本绝不丢失**（flows L310-313）。✅
- 空输入 no-op、不调 AI（3c-2b: E3）；每次成功 refine 恰建一个 Thought（inbox: W）；中途不产生半成品 Thought（inbox: V/U3）。✅

## 7. Creative Inbox Flow（实测）

- **入箱唯一路径 = REFINE 成功**。普通输入不入箱（inbox: E1/N）；Voice 不入箱（inbox: T）；ADD 不入箱、转投 Composer（flows L257-267）。✅
- Thought 模型（thought.js）：`originalText` 逐字节保留用户原话；`refinedText` 独立派生副本，异步附加，**永不覆盖 originalText**。✅
- UI 语义清晰：`VOICE/TEXT` 来源标签 + `REFINED` 标签分离展示（renderer L307-339），原文永不被 AI 输出遮蔽。✅
- 所有本地操作（编辑/删除/复制/展开）零 AI、零异步阻塞（inbox: V）。✅
- 展开/收缩 + 长文滚动 + 与 Composer 共存：见 Matrix #12/#13/#19/#20。✅
- **缺口**：刷新即全部丢失（见 Matrix #9）。

## 8. USE Semantics（如实报告，不做任何修改假设）

**当前真实行为**（flows `sendThoughtToPrompt` L319-331 + 测试）：

1. 取 Thought 的 `refinedText`（优先）或 `originalText` 兜底（B2）。
2. **整体替换** Composer 当前内容（`updateInput(trimmed)`，replace 而非 append）——测试 B1 明确锚定此行为。
3. 不自动 submit（B1）；Thought 不被消费/删除，可重复 USE（B4/Y）。
4. 未知 id no-op，不清空 Composer（B3）。
5. 取回时终止任何 voice 会话和进行中 AI 请求（防竞态）。

**当前测试覆盖**：B1-B4、U、U2、Y、Z（8 个用例，替换语义被测试显式锁定）。

**当前产品文档定义**：3C-2B 交付报告记录 USE 为 take-back 无自动提交；3C-3A PRD（未批准）提议改为 append，标记为 Q1 开放问题。

**语义冲突**：✅ **存在**。
- Voice append、Inbox ADD append、USE replace——同为"进入 Composer"的路径语义不统一。
- **数据丢失风险**：Composer 有未发送内容时点 USE，已有内容被直接覆盖（无确认、无恢复）。
- 这与产品基线"Composer 是用户最终组织 Prompt 的主要空间 / 程序化操作不应丢内容"存在张力。

> **PRODUCT DECISION REQUIRED #1**：USE 保持 replace 还是改为 append（或追加式合并 / 带确认）。审计不做任何倾向性假设，仅报告事实。**在裁决前，USE 语义维持现状（replace），3C-3A PRD 的 Q1 提案冻结待批。**

## 9. Review / Submit Flow（实测）

- Review 是最终提交前的审阅阶段：Original（用户原话逐字节，只读，永不从 AI 输出重构）/ Optimized（版本链头，可编辑/IMPROVE/REWRITE）二选一。✅
- Submit 路径：`confirmAndSend` → review 态 → CONFIRM → ready_to_send → SEND → sending → `delivery.deliver()` → delivered。
- **实测事实**：`deliver()`（clipboard-provider L31-33）**不执行任何投递**——不写剪贴板、不发送到任何外部目标，仅返回 `{ok:true, channel:"clipboard", prepared:true}`。代码注释自述 "demo: prepares channel"。
- **真实的内容出口**：COPY 按钮（`copyPrompt` → 剪贴板写入，含 Original 逐字节复制，voice-loop: O）。
- 即：**状态机到达 DELIVERED 是真实的流程终点，但"已发送"的内容实际停留在用户剪贴板操作之外**——用户若不点 COPY，提交的内容不会到达任何目的地。

> **PRODUCT DECISION REQUIRED #2**：Submit 的投递通道何时做实（剪贴板自动写入 / 打开目标 AI / 3C-3E Delivery 多目标）。当前为已知 demo 层，非隐藏缺陷，但需在路线图中显式排期，避免"DELIVERED"被误解为真实送达。

## 10. P0 Completed（17 项）

Voice continuous input / Voice explicit Stop / Voice→Composer (append) / Text→Composer / Composer editing / REFINE (显式) / REFINE→Inbox / Thought edit / Thought delete / Thought collapse-expand / Thought long-text scrolling / USE (实现完整，语义待裁决) / USE→Pipeline / Review / Voice error recovery / Inbox scrolling / Composer+Inbox coexistence。

## 11. P0 Partial（3 项）

| 项 | 缺的部分 | 影响 |
|----|----------|------|
| Composer append 语义统一 | USE 是 replace（其余路径 append） | 覆盖丢失风险 + 语义不一致 |
| Thought persistence | 仅会话内存活；刷新全丢；storage 接口无 inbox API | 用户积累的想法不可恢复 |
| Submit 投递通道 | deliver() 为 stub，DELIVERED 无真实送达 | 状态语义与真实效果脱节 |

## 12. P0 Missing（0 项核心链路缺失）

基线定义的 P0 链路无缺失环节。Note：Thought 持久化按基线字面（"支持创建/查看/编辑/删除/展开/收缩/长文本滚动/USE"）均已实现；跨刷新持久化是基线未显式列出但产品上高度期望的能力，本审计将其列为 P0 缺口供裁决（也可裁决降级为 P1）。

## 13. Product Drift（10 项逐条核查）

| # | 检查项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | USE 语义已改变？ | **未变**（仍是 3C-2B 验收时的 replace；但存在与 append 路径的语义冲突 → 决策 #1） | flows L329; 3c-2b: B1 |
| 2 | Voice 变 replace？ | **未变，且从未** — 全路径 append | machine L156-161 |
| 3 | REFINE 自动触发？ | **否** — 仅显式按钮 | main.js L87 |
| 4 | Inbox 保存了不该保存的原始内容？ | **否** — 入箱必须经过 REFINE 成功；originalText 是用户原话快照（产品语义要求保留），refinedText 独立存放，UI 双标签清晰 | machine L207; thought.js |
| 5 | Composer 因程序化操作丢内容？ | **一条路径会**：USE replace 覆盖（决策 #1）。其余路径（Voice append / ADD merge / REFINE 保留 / CANCEL 恢复快照）均不丢 | flows L263/L329 |
| 6 | Thought 真能回 Composer？ | **是** — USE 全链路 + 手动 Submit 进管线 | inbox: U/U2/Z |
| 7 | Review 仍是提交前最终阶段？ | **是** | machine L43 |
| 8 | 有 UI 无真实数据流的功能？ | **一处**：Submit 的 delivered 终态（deliver stub，见 §9）。其余 UI 元素均有真实数据流 | clipboard-provider L31 |
| 9 | Mock 被误认为真实 AI？ | **风险存在**：`fallback-service` 在 NETWORK_ERROR 时**静默**切本地 Demo（正确设计：真实 AI 错误会传播），但 UI 无任何模式指示——纯静态部署（无后端）时用户会把 Demo 输出当真实 AI | fallback-service L12-14 | 
| 10 | 与原始 P0 定义冲突？ | **无实质冲突**。三处张力：USE 语义（决策 #1）、Submit stub（决策 #2）、Demo 模式无指示（建议决策 #3：加状态标识） | 全文 |

## 14. Product Decisions Required（等小默裁决）

> **DECISION #1 — USE 语义**：replace（现状）vs append vs 合并确认。裁决前不动代码，3C-3A PRD Q1 冻结待批。
> **DECISION #2 — Submit 投递通道**：何时做实（自动剪贴板 / 打开目标 AI / 3C-3E 多目标）。
> **DECISION #3 — Demo 模式可见性**：断网/无后端回落 Demo 时，是否在 UI 显示模式标识（如状态栏 "DEMO" 徽章），避免 Mock 输出被当真实 AI。
> **DECISION #4 — Thought 持久化分级**：跨刷新持久化列为 P0 还是 P1（影响 3C-3A 或独立小阶段排期）。

## 15. P1 Enhancements（全部标记 P1 / ENHANCEMENT，未实现）

| 项 | 现状 | 来源 |
|----|------|------|
| Draft Persistence（Composer 草稿持久化） | ❌ 未实现（CLOSE_FLOAT 会话内存活，刷新丢） | 3C-3A PRD 提案（未批准） |
| Undo / Redo | ❌ 未实现 | 3C-3A PRD 提案（未批准） |
| Status Badge（EMPTY/DRAFT/SAVED 等） | ❌ 未实现（现有 statusLabel 是流程态标签，非草稿保存状态） | 3C-3A PRD 提案（未批准） |
| Inbox capture draft persistence（捕获框草稿持久化） | ❌ 未实现 | 3C-3A PRD 提案（未批准） |

**以上四项均为 P1，不与 P0 核心混淆，且均未动工。**

## 16. AI Implementation Status

| 能力 | 状态 | 证据 |
|------|------|------|
| ai.analyzePrompt（understanding/structuring + REFINE 入箱） | **REAL** — DeepSeek 真实链路 2026-08-31 实测通过（AI_MODE=real）；网络故障回落 Demo | deepseek-integration / 真实 Key 实测记录 |
| ai.improvePrompt / rewritePrompt（C1/C2） | **REAL** — 同一网关/Provider 通道 | api-contract / gateway 测试 |
| intent-compiler Skill（AI 理解内核） | **REAL** — v1.1 FROZEN；Benchmark 50 案例 98.7% | benchmark-v1 测试 |
| Voice 识别 | **REAL** — 浏览器原生 Web Speech API（非自建 mock；测试用 mock provider 测的是状态机，产品用真浏览器能力） | browser-provider.js |
| AI 请求取消/防陈旧 | **REAL** — AbortController + reqSeq + voiceSession 三层 | voice-loop: G/H/I |
| **Delivery 投递通道** | **MOCK** — deliver() stub（仅 COPY 是真实剪贴板） | clipboard-provider L31 |
| **前端 Demo Provider** | **MOCK（按设计的降级层）** — 确定性关键词规则，无随机；仅在 NETWORK_ERROR 时静默启用 | demo-provider.js |

**无 Mock 被伪装成真实实现**——唯一需注意项为 §13 #9 的静默回落无 UI 指示（已列决策 #3）。

---

## 17. Recommended Next Phase（建议，仅供参考，等裁决）

1. **先裁决 §14 四项 DECISION**（尤其 #1 USE 语义——它直接决定 3C-3A PRD 是否需要修订后再批）。
2. DECISION #1/#4 裁决后 → 修订并批准 3C-3A PRD → 按既定纪律（Approved → Implementation → Tests → E2E → Delivery Report）动工。
3. DECISION #2（投递通道）建议纳入 3C-3E Delivery Sprint，不建议在 3C-3A 中顺手改（避免一次改动跨两个语义域）。
4. DECISION #3（Demo 标识）为小改动，可作为任一 Sprint 的附带项，但需显式进 Spec。

---

## 18. Audit Integrity Statement

- 本审计**未修改任何文件**（git 工作树仅新增本报告 + 既有 3C-3A 文档，均未跟踪、非代码）。
- FROZEN 集（server/Skill/golden/schema/版本链）**零接触**。
- 所有结论均有代码行号或测试用例名支撑，无凭印象判断。
- 审计到此为止，**不进入任何实现**。等待产品负责人确认。

*— End of Audit Report —*
