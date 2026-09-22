# PHASE 3D-RC2 — 3E 简化 + 五点体验修复 交付报告

日期：2026-09-02 · 基线：3D-RC1（346 tests）→ 本次 339 tests

## 用户反馈 → 修复映射

| # | 用户反馈                       | 根因                                                                  | 修复                                                                                                               | 验证                                     |
| - | -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1 | Composer listening 区文本一直重复 | provider `onresult` 从 resultIndex=0 全量遍历 Chrome 累积结果，历史 final 被重复计入 | `browser-provider.js`：仅遍历 `e.resultIndex` 之后的新增结果；final 累积进 `carryText`、interim 仅预览；same-instance resultIndex 去重 | CHROME-01..04 / VOICE-DUP-01..08       |
| 2 | 关闭 × 后悬浮窗消失，应常驻桌面小圆标       | `machine.js` 中 `CLOSE_FLOAT: hidden` 直接隐藏                           | `CLOSE_FLOAT: minimized`，× 与收起一致进 Orb；语音 teardown 保留                                                             | voice-error-reset #2/#2b（close 仍清语音残留） |
| 3 | 窗口被其他内容遮挡                  | z-index 9999 低于常见弹层                                                 | `#pk-float` / `#pk-minimized` z-index=2147483000，toast 2147483200                                                | ORB-VISUAL-07                          |
| 4 | Inbox 不够简约、编辑路径冗长          | EDIT 按钮占位 + 原/优化并排显示                                                | 仅显示“优化后”；切换按钮查看“优化前”；点文本即编（含键盘 Enter/Space）；DELETE / COPY 悬停显示；移除 USE 按钮                                         | UI-02 / UI-28 / D1 / D2                |
| 5 | 语音只有第一句逐字浮现，后面突然跳入         | interim 只在首个 segment 生效；后续 segment 直接 final 提交无预览                   | GATE B：interim 尾段实时合并进 Composer（display-only + readOnly + `pk-voice-live` 光效）；state.input 只存 finals              | GATE-B / GATE-B2                       |
| 6 | SUBMIT 后出现三段英文思考/分析文本      | 旧管线仍有 understanding/structuring/review 中间态                          | 3E 简化：SUBMIT 直接将 Composer 内容存入 Creative Inbox，无中间态、无英文步骤提示                                                       | flow\.integration / DP-5 / UI-25       |
| 7 | C1/C2 等冗余功能干扰核心流程          | Improve/Rewrite 按钮与相关管线仍存在                                          | 移除 C1/C2 按钮及 `improving`/`rewriting` 相关 UI；仅保留“优化”和“提交”                                                          | UI-02 / machine.test                   |

## 3E 核心状态变更

* `machine.js`: `CLOSE_FLOAT` 目标从 `hidden` 改为 `minimized`；`SUBMIT_THOUGHT` 直接创建 Thought 并入箱，interaction 保持 `idle`。

- `prompt-flow.js`: `confirmAndSend` / `submitThought` 直接入箱；`refineFromComposer` 将优化结果写回 Composer 并保留 original/refined 对，由 SUBMIT 入箱；引入 `refineReqSeq` 防止取消的 REFINE 在 `finally` 中误清 pending 标志。

* `renderer.js`: 重构 Thought 卡片，默认显示 `refinedText`，可切换 `originalText`，点击文本进入编辑，DELETE 悬停显现。

* `selectors.js`: `confirmEnabled` 仅在 `idle`/`input` 态返回 true，避免旧中间态误触发 SUBMIT。

* `float.css`: 增加浮窗→Orb 收缩动画；拆分 `.pk-thought-delete` hover/focus 规则以通过可访问性契约。

* `index.html` / `main.js`: 移除 C1/C2 按钮与旧视图 HTML。

## 测试适配

为匹配 3E 行为，更新以下测试文件中的断言与选择器：

* `tests/3c-2b.test.js`: D1/D2 选择器切到 `.pk-thought-body`；fake DOM 补充 `closest()`。

* `tests/3c-3a.test.js`: DP-5 改为“REFINE/SUBMIT 清 Draft；Voice/USE 不清”。

* `tests/3c-3b.test.js`: UI-28 删除按钮 hover 断言。

* `tests/inbox.test.js`: U / U2 / X / Z 适配 SUBMIT 直接入箱、无 AI 调用、无 session。

* `tests/voice-loop.test.js`: I 适配 `refineReqSeq` 防误清；G/H 改为 REFINE 流程。

* `tests/machine.test.js`: 删除旧管线路径测试，保留语音/错误/状态转换。

* `tests/models.test.js`: `confirmEnabled` 对 `understanding` 返回 false。

## GATE 清单

* **GATE A 语音根修** ✅ finals 累积模型 + no-speech 会话终止时上报 + Chrome 累积事件专项测试

* **GATE B 边说边浮现** ✅ 每句都有逐字浮现效果（preview = 已提交 + interim 尾段）；已有草稿叠加不丢

* **GATE C × → Orb** ✅ CLOSE\_FLOAT 收起为 Orb 常驻；语音 teardown / 草稿保留行为零回归

* **GATE D 置顶** ✅ Float/Orb z-index 2147483000；toast 层级更高

* **GATE E Inbox 简约化** ✅ 点文即编、按钮精简、优化后/前可切换

- **GATE F 全量回归** ✅ 339/339 pass · lint OK · build OK · FROZEN 47 文件 SHA256 与 `frozen-baseline-3c3b.txt` 一致

## 3E 第二轮体验修复（本次会话）

针对实际操作中发现的 4 个问题，在 3E 简化基础上做第二轮调整：

| # | 反馈                                     | 修复                                                                                                                            | 关键文件                                           |
| - | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1 | SUBMIT / REFINE 缺少“咻”的入箱动画             | SUBMIT 时给 Composer 加 `.pk-submit-suck`（纸张抽入）；Inbox 新增最后一条 Thought 时加 `.pk-thought-enter`（弹出）                                  | `renderer.js` / `float.css`                    |
| 2 | REFINE 直接弹进 Inbox，想先优化在 Composer 再手动提交 | 新增 `REFINE_RESULT` action；`refineFromComposer` 将 AI 结果写回 Composer；`SUBMIT_THOUGHT` 检测 `refineResult` 匹配时存储 original/refined 对 | `actions.js` / `machine.js` / `prompt-flow.js` |
| 3 | Inbox 每条 Thought 需要一键复制                | Thought 卡片 footer 加 `COPY` 按钮，悬停 / focus 显示，点击复制当前显示版本（优化后/前）                                                                 | `renderer.js` / `main.js` / `float.css`        |
| 4 | listening 小字多余且呼吸灯不够醒目                 | 移除 listening 状态的小字提示；语音按钮 listening 时增加外圈扩散光环 + 内部呼吸点，并给 Float 加 `.pk-listening` 全局状态                                         | `renderer.js` / `float.css`                    |

### 本轮变更文件

* `src/state/actions.js` — 新增 `REFINE_RESULT`。

* `src/state/machine.js` — 处理 `REFINE_RESULT`，保留 `refineOriginal` / `refineResult`；`SUBMIT_THOUGHT` 生成 original/refined 对。

* `src/flows/prompt-flow.js` — `refineFromComposer` 改 dispatch `refineResult`；`copyThoughtToClipboard` 绑定 COPY。

* `src/ui/renderer.js` — COPY 按钮渲染、卡片进入动画、Composer paper-suck 动画、listening 小字移除。

* `src/main.js` — COPY 事件绑定（若尚未绑定）。

* `css/float.css` — `.pk-submit-suck` / `.pk-thought-enter` 动画；语音按钮双层呼吸效果；`.pk-thought-copy` 悬停样式。

* `tests/flow.integration.test.js` — 适配 demo provider 真实输出。

* `tests/voice-loop.test.js` — I 测试适配 REFINE→Composer→SUBMIT 流程。

## 已知边界

* z-index 置顶为页面内最高层级；浏览器多窗口叠加（其他应用置顶）不在 Web 能力范围内，需 Electron 壳（后续阶段）。

* 逐字浮现依赖 Chrome interim 事件频率；真机 iOS Safari 的 Web Speech 支持仍需 3E 真机验证。

* Quick Menu 为 RC2 预留桩；listening/processing 状态需真机验证。

## 下一步建议

PHASE 3E：官网嵌入 + Mobile 真机 E2E + Pre-release QA。
