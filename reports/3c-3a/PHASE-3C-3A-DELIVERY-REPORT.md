# PHASE 3C-3A DELIVERY REPORT

- **日期**：2026-08-31
- **基线**：v0.3.2-3c2b（204 tests）
- **交付后基线**：248 tests / 248 pass（`node --test`，3.8s）
- **范围**：USE = APPEND 语义变更、Thought Persistence（P0）、Draft 持久化、应用层 Undo/Redo、状态徽章、REAL/DEMO 可见性
- **FROZEN 集零改动**：`git diff --name-only v0.3.2-3c2b` 无任何 server/**、intent-compiler、golden fixtures、六字段 schema（models/prompt.js）、version chain 文件
- **真实 Delivery 留给 3C-3E**：未实现（本阶段 delivery 仍为 demo channel 准备，符合授权边界）

---

## 1. USE Semantic Change（DECISION #1）

**行为**：Inbox thought 的 USE 按钮从「替换 Composer」改为「非破坏性追加」。

```
newText = existing.trimEnd() + "\n\n" + thought.trim()
```

- 不覆盖用户已有内容（Composer 内部文字永不修改，仅规范化拼接边界）
- 不自动 Submit（USE 后停留在 input 态，用户自行决定下一步）
- 不消费 Thought（USE 后 Inbox 计数不变，thought 可重复使用）
- 实现位置：`src/flows/prompt-flow.js` `sendThoughtToPrompt()`

**E2E 证据（STEP 8 / STEP 11 / STEP 14 重跑）**：
- Composer 原文 165 字节保留，追加后 `原文\n\nThought` 精确成立
- 组合场景：A 打字 + B 语音 + C USE 三层追加，undo×3 逐层剥离回到 A
- USE 后 Inbox 计数不变（thought 未消费）

## 2. Thought Persistence（DECISION #2，P0）

- localStorage 键：`pk-float:inbox`，结构 `{v:1, thoughts:[...]}`（id/originalText/refinedText/source/createdAt/updatedAt）
- 写入时机：add / edit / refine 入 inbox / delete 均即时持久化
- 启动恢复：`main.js` boot 阶段 best-effort 恢复（静默降级——损坏数据不阻塞启动）
- 恢复内容不做 AI 处理、不自动 REFINE、不自动提交
- **E2E**：刷新后 thought 仍在、顺序保留；DELETE 后刷新不再出现

## 3. Draft 持久化（Enhancement #1）

- localStorage 键：`pk-float:draft`，结构 `{v:1, text}`
- 500ms debounce：`UPDATE_INPUT` 触发防抖保存（UI 即时显示 SAVED/UNSAVED）
- `pagehide` flush：卸载/刷新前强制落盘
- 启动恢复：Composer 一字不差恢复（165 字节 E2E 验证）
- **delivered 语义（§6.4）**：完成的 submit 清除磁盘 draft；屏内文字保留至 NEW（delivered 视图拥有屏幕），刷新后从干净状态开始
- 已知细节：USE 追加等程序性写入不重置 debounce 定时器（非 UPDATE_INPUT），磁盘 draft 短暂滞后，由 pagehide flush 兜底——刷新不丢数据

## 4. 应用层 Undo/Redo（Enhancement #2）

- 新文件 `src/state/history.js`：纯函数 history `{past[], present, baseline, future[], pushedAt}`
- **baseline 语义**：创建历史时（空 Composer 或恢复的 draft）记为 baseline，永不进 past；首段用户 typing 直接并入 baseline（past.length 只计用户步骤）
- typing 合并：~500ms 内连续输入合并为一步（§7.3）；程序性写入（USE 追加、Voice merge、版本切换）永不走合并路径（§7.4）
- undo 可回到 baseline（含恢复的 draft）；redo 不把 baseline 压入 past
- 门控（X-2 契约）：仅 idle/input 态可 undo/redo；delivered 后按钮禁用（E2E 验证 disabled=true）
- 快捷键：Ctrl/Cmd+Z undo、Ctrl/Cmd+Shift+Z redo，输入框内 preventDefault 接管原生栈
- 选区跟随：undo/redo 恢复 caret 位置

**缺陷修复（STEP 8 浏览器 E2E 抓到的真实产品缺陷）**：
- 现象：Composer 聚焦时 Ctrl+Z 一次退两步（165→54）
- 根因：`globalUndoRedo` 中 `t !== refs.input` 例外导致 input 级 dispatch 后事件冒泡至 document 再 dispatch 一次
- 修复：跳过所有 TEXTAREA/INPUT（其他 surface 的原生 undo 保留）
- 修复后：172→165→172 单步精确
- 位置：`src/main.js` `globalUndoRedo`

## 5. 状态徽章（Enhancement #3）

- `#pk-draft-badge`：EMPTY / DRAFT / DRAFT · VOICE / DRAFT · THOUGHT（Draft 来源可见）
- `#pk-draft-saved`：SAVED / UNSAVED（防抖落盘状态）
- interaction 状态照旧由 statusLabel 呈现；两者互补

## 6. REAL/DEMO 可见性（DECISION #3）

- `#pk-ai-mode`：`AI · REAL` / `AI · DEMO`
- 判定：`fallback-service` `onMode` 回调——主链路（http→server→DeepSeek）成功应答 = real；`NETWORK_ERROR` 降级本地 Demo = demo；其他错误传播（模式不变）
- **Demo 不伪装 Real**：降级后徽章如实显示 AI · DEMO
- 首次 AI 调用前徽章隐藏（设计行为，代码注释明确）
- **E2E（STEP 12）**：杀死 server 进程→REFINE 走降级→AI · DEMO + 降级应答仍成功；重启 server→恢复 AI · REAL

## 7. Tests

- `npm test`：**248 / 248 pass**（204 旧全保留 + 44 新增 `tests/3c-3a.test.js`）
- 新增覆盖：USE=APPEND（USE 系）、Thought 持久化（DP 系）、history 单元（H 系）、machine 门控（M 系）、selectors（S 系）、时间注入（`action.now` 透传模拟打字间隔）
- `npm run lint`：PASS（DOM 仅 ui/+main.js、env 仅 config/env.js、前端无 secrets）
- `npm run build`：PASS（dist/ 完整产出）
- 修复的测试期望错误（非产品缺陷，§15 合规——产品代码以 E2E 实测为准）：Voice 空格分隔符、时间注入、no-op dispatch

## 8. E2E（agent-browser，http://127.0.0.1:8787，AI_MODE=real）

| Step | 内容 | 结果 |
|---|---|---|
| 8 | Text→Voice(MockSR)→REFINE→Inbox→USE append→Edit→Undo/Redo 按钮与快捷键→Review→Submit→delivered→draft 清除 | PASS（截图 step8-core-chain-delivered.png） |
| 9 | 刷新恢复 draft 165 字节一字不差、Thought 仍在、EDIT/DELETE 持久化 | PASS |
| 10 | 数据丢失验证：原文保留 / Undo 精确恢复 / Thought 不消费 | PASS（截图 step10-undo-restores-original.png） |
| 11 | A+Voice B+USE C 层层追加 + undo×3 逐层剥离 | PASS |
| 12 | 断网→AI·DEMO+降级应答成功；恢复→AI·REAL | PASS（截图 step12-demo-badge.png） |
| 13 | 桌面 1280×900：float 620×580 inViewport、无横向滚动、控件全可见 | PASS（截图 step13-viewport-1280x900.png） |
| 13 | 移动 375×667：float 345×520 (min(92vw,620))、无横向滚动、undo/redo/voice/refine/inbox/submit 全可见、Inbox 展开 269×132 无溢出、AI·REAL | PASS（截图 step13-viewport-375x667.png） |
| 14 | 全量重跑：test 248/248、lint、build、浏览器核心链路（真实 AI：REFINE 应答 "Write a short poem about morning light."、USE 精确追加、AI·REAL、delivered 后 draft 磁盘清除+undo 禁用） | PASS |

## 9. FROZEN Audit

`git diff --name-only v0.3.2-3c2b`（工作区全部变更）：

```
css/float.css
index.html
src/flows/prompt-flow.js
src/main.js
src/services/ai/fallback-service.js
src/services/storage/local-storage.js
src/state/actions.js
src/state/machine.js
src/state/selectors.js
src/ui/renderer.js
tests/3c-2b.test.js
新增：src/state/history.js、tests/3c-3a.test.js、reports/3c-3a/
```

**FROZEN 命中 = 0**：无 `server/**`、无 `intent-compiler`、无 `tests/fixtures/prompt-intelligence/`（golden）、无 `models/prompt.js`（六字段 schema）、无 version chain 文件。

## 10. Known Limitations

1. **REAL/DEMO 为传输层判定**：onMode 只反映「哪个 transport 应答」，不校验应答内容质量；server 返回 5xx 等非网络错误时错误传播（模式保持旧值，用户看到错误提示而非徽章变化）。
2. **server 健康端点无模式信息**：`/api/v1/health` 不暴露 AI_MODE；前端启动时无法预探测模式，首徽章只能等首次 AI 调用（设计取舍，见 §6）。建议 3C-3E 前给 health 加 `mode` 字段（涉及 server 改动需解冻审批）。
3. **Ctrl+Z 双重 dispatch 缺陷已修复**（§4），但揭示了事件冒泡路径测试盲区——快捷键回归依赖浏览器 E2E 而非单测覆盖。
4. **环境坑：TaskStop 不杀 node 子进程**——`npm start` 的 TaskStop 只终止 npm 包装进程，node（监听 8787）继续存活，导致 STEP 12 首轮 DEMO 验证失效。须 `taskkill /PID <pid> /F` 真正停服。
5. **agent-browser 交互坑**（记录供复用）：坐标点击偏移→改 JS `.click()`；`type` 不生效→`focus`+`keyboard type`；init-script 注入 MockSR 是新会话唯一入口；eval 变量需 IIFE 包裹；Float 根元素是 `#pk-float`（id），className 为空。
6. **delivered 后 DRAFT 徽章仍亮**：磁盘 draft 已清（§3 语义），但屏内文字保留导致 badge 显示 DRAFT——屏由 delivered 视图拥有，属设计内；若观感违和可在 3C-3E 前让 badge 在 delivered 态隐藏。

## 11. Final Verdict（13 项验收）

| # | 验收标准 | 结果 |
|---|---|---|
| 1 | USE = APPEND 精确语义（不覆盖/不自动 submit/不消费） | ✅ |
| 2 | Thought 跨刷新持久化（localStorage） | ✅ |
| 3 | Draft 500ms debounce + pagehide flush + 启动恢复 | ✅ |
| 4 | 应用层 Undo/Redo（typing 合并、程序写入独立步、baseline） | ✅ |
| 5 | Undo/Redo 门控（仅 idle/input；delivered 禁用） | ✅ |
| 6 | 快捷键单步精确（双重 dispatch 已修复） | ✅ |
| 7 | 状态徽章 EMPTY/DRAFT/DRAFT·VOICE/DRAFT·THOUGHT + SAVED/UNSAVED | ✅ |
| 8 | AI · REAL / AI · DEMO 徽章（Demo 不伪装 Real） | ✅ |
| 9 | 断网降级链路完整（DEMO 应答成功 + 徽章如实） | ✅ |
| 10 | 新增测试 ≥ 最低要求且全绿（44 新增，248/248） | ✅ |
| 11 | 浏览器 E2E 核心链路（STEP 8/10/11/12/14） | ✅ |
| 12 | 视口回归 1280×900 + 375×667 无溢出、控件可用 | ✅ |
| 13 | FROZEN 集零改动（git diff v0.3.2-3c2b） | ✅ |

**FINAL VERDICT: PHASE 3C-3A — PASS（13/13）**

---

*附：截图证据在 `review/3c-3a/`；PRD/TECH-SPEC 在 `reports/3c-3a/`；下一步 Phase 3C-3E（真实 Delivery）未在本阶段实施。*
