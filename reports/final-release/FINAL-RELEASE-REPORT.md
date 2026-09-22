# PromptKey Float — Final Release Report

日期：2026-09-04 · 基线：Phase 3D-RC2（339 tests）

---

## 1. Release Summary

- **Version**: 0.3.0（package.json）
- **Commit**: `3207b3c`（Phase 3C-3A 基线 commit；3C-3C / 3D-RC1 / 3D-RC2 工作处于未提交工作树状态）
- **Branch**: main
- **Date**: 2026-09-04
- **Node**: v22.23.2 · npm 10.9.8

## 2. Baseline（GATE 0 实测，非历史数字）

| 项 | 实测结果 |
|---|---|
| Tests | **339 pass / 0 fail**（`node --test`，~3.5s） |
| Lint | PASS（frontend/backend 护栏成立） |
| Build | PASS（dist 产物生成，含 orb.js/shortcuts.js） |
| Frozen | **47/47 一致，0 mismatch**（SHA256 对照 frozen-baseline-3c3b.txt） |
| Working Tree | 大量 modified + untracked（3C-3C/3D 工作未 commit） |

## 3. Product Status（GATE 1 产品契约逐条核对）

核心链路 `TEXT/VOICE → Composer → REFINE → Inbox → USE/COPY/EDIT/DELETE → SUBMIT` 全部成立：

- ✅ Composer 是用户主要写入口（`withComposer` 唯一写路径）
- ✅ Voice append 到 Composer（不覆盖）
- ✅ REFINE 不破坏原始表达（`refineOriginal`/`refineResult` 分离）
- ✅ AI refined 独立保存（`thought.js` originalText 逐字节保留）
- ✅ Inbox 保存 AI 处理后 Thought
- ✅ Thought 可再次使用
- ✅ **USE = APPEND**（`existing.trimEnd() + "\n\n" + trimmed`，不覆盖/不自动 submit/不消费）
- ✅ Thought 刷新后仍存在（`pk-float:inbox` 持久化）
- ✅ Undo/Redo 无数据丢失（应用层 history，baseline 语义）
- ✅ Voice 停顿不自动结束、显式 Stop 才结束、transcript 不重复
- ✅ REAL/DEMO 状态可见（`AI · REAL` / `AI · DEMO` 徽章）
- ✅ AI 失败不破坏 Composer 原文（REFINE catch 仅 toast）
- ✅ Orb 可重新打开 Float、Collapse 后可访问
- ✅ 长内容不静默截断（见 §4 Long Text）

## 4. Composer + Long Text Safety（GATE 4）

- `COMPOSER_LIMIT = 2000` 单一定义（`actions.js`），Composer **无 maxlength 硬截断**。
- 超 2000 字 → 整段 promote 为 **LONG DOCUMENT** 入 Inbox + Composer 清空 + toast，**无静默丢字**。
- 语音溢出同样 promote（VOICE-DUP-07 边界测试）。
- 测试覆盖：LONG-01..10。

## 5. Voice（GATE 2）

- 去重根因修复：`browser-provider.js` 仅遍历 `e.resultIndex` 之后新增结果；final 累积、interim 仅预览。
- 五层防护：`instanceDedup + segmentSeq + finalSig + voiceSeq + voiceCommittedLen`。
- 测试覆盖：voice-dup.test.js + voice-loop.test.js（8 case 全绿）。

## 6. UX Status（GATE 9/10/11）

- **Website**：`index.html` 即官网 + Float 形态（Hero/流程/功能卡片/Footer + Float + Orb）。本次修复 3 处过时文案（C1/C2、USE、REFINE 直接入箱 → 与 3E 简化后语义对齐）。
- **Desktop / Responsive**：1280/1440/1920 及移动 375/390/430 由既有测试与 CSS 覆盖。
- **Accessibility**：aria-label / aria-live / aria-expanded / aria-keyshortcuts / role 完整；`:focus-visible` 与 `prefers-reduced-motion` 降级存在。
- **Mobile 真机**：NOT VERIFIED（本环境无真机/DevTools 模拟证据，需外部环境）。

## 7. AI Status（GATE 6）

- Provider：DeepSeek Flash（`deepseek-chat`）。
- 架构：Frontend → Backend AI Gateway（server）→ DeepSeek → structured result → state。**Key 仅 server 端读取**（`env.js` 注释 "never shipped to browser"），前端 `src/` 无 key 泄漏（grep 0 命中）。
- REAL / DEMO：`fallback-service` 真实 AI 优先，失败才 demo fallback，`onMode` 上报真实模式；UI 徽章区分，**Demo 不伪装 Real**。
- 失败原则：AI 失败 ≠ Composer 数据丢失。
- 本地实测：`127.0.0.1:8787` 启动日志 `AI_MODE=real, provider=deepseek` ✅。

## 8. Security（GATE 12）

- ✅ 前端 bundle 无 API key / secret / token（grep 0 命中）。
- ✅ `env.js` 是唯一 `process.env` 读取点（lint-enforced）。
- ✅ git 已追踪文件仅 `.env.example`（安全模板，无 key）。
- 🔧 **本次修复**：`.gitignore` 由 `.env` 改为 `*.env`，修复 `(2).env`（含真实 key 的副本）未被忽略、可能被 `git add -A` 误提交的安全隐患。修复后 `(2).env` 与 `.env` 均不再出现在 untracked 列表。
- ⚠️ 提醒：`(2).env` 文件本身仍含真实 key，建议手动删除（非代码层可处理）。

## 9. Performance（GATE 13）

- 单次 boot、单 store.subscribe、无重复网络请求。
- src 无 `console.log/debug/debugger/TODO/FIXME/HACK`（grep 0 命中）。
- 无 listener/timer/recognition 实例泄漏路径（voice teardown 完整）。

## 10. Error / Recovery（GATE 14）

- AI timeout / 500 / 429 / 网络不可用 / 语音权限拒绝 / clipboard 拒绝 / malformed / storage 失败均有测试覆盖（rc1-error-matrix.test.js 等）。
- 核心原则成立：任何单点失败不摧毁用户已输入内容。

## 11. Regression（GATE 15）

- **Total 339 / Pass 339 / Fail 0 / Skipped 0 / Todo 0**
- 测试数变化说明：3D-RC1 346 → 3D-RC2 339，是删除 C1/C2 冗余功能及对应测试的**预期收敛**，非回归。

## 12. Deployment（GATE 17-19）

- **Deployment Readiness**：生产配置方式已就绪（`.env` / 环境变量：`AI_MODE=real`、`AI_PROVIDER=deepseek`、`AI_API_KEY` 等，`env.js` 优先级 overrides > process.env > .env > fallback）。
- **Deployment**: **BLOCKED — EXTERNAL ENVIRONMENT REQUIRED**。缺少：云服务器凭据、域名、HTTPS 证书、生产环境变量注入。本环境无部署凭据，**不伪造部署成功**。
- **Production Smoke Test**: 本地 REAL 模式已验证（`127.0.0.1:8787`，deepseek 接通）；**线上 smoke 未执行**（依赖 Deployment）。

## 13. Known Limitations（仅真实剩余限制）

1. 页面级 z-index 置顶（2147483000）为浏览器内最高；跨应用置顶需 Electron 壳。
2. iOS Safari 的 Web Speech interim 事件频率需真机验证（逐字浮现效果）。
3. CSS 存在全局选择器（`*`/`html`/`body`/`button`）——当前 index.html「官网+Float 同文件」场景安全，但嵌入第三方页面需先做 `pk-*` 与 `site-*` 样式分离（未在本次处理，避免 feature creep）。
4. 无账号/云同步/团队协作（按产品 FROZEN 约束明确不做）。
5. Quick Menu / 双击 / 长按为 Orb 预留桩，未实现（RC2 决策）。

## 14. Release Decision

**代码层面：GO（Release Candidate 就绪）**

- 全部代码级 GATE（0-16）PASS：339 测试全绿、lint/build 通过、FROZEN 47/47、无 Release Blocker、security 隐患已修复、产品语义一致。
- 无任何 RELEASE BLOCKER（无数据丢失 / 语音重复 / Composer 覆盖 / USE 覆盖 / key 暴露 / 构建失败 / Orb 不可访问 / 核心链路断裂）。

**部署层面：BLOCKED（EXTERNAL ENVIRONMENT REQUIRED）**

- 需外部环境才能完成正式上线：云服务器 + 域名 + HTTPS + 生产环境变量（`AI_MODE=real` + `AI_API_KEY`）。

**最终结论：GO for Release Candidate，Deployment 待外部环境（阿里云 ECS + 域名 + 生产 env）后即可上线。**

---

## 15. 本次会话实际修改（Final Release Closure 变更清单）

| 文件 | 修改 | 原因 |
|---|---|---|
| `index.html` | 3 处功能卡片文案修正 + 1 处注释修正 | 官网文案与 3E 简化后语义对齐（C1/C2 已删、USE 按钮已删、REFINE 写回 Composer 而非直接入箱） |
| `.gitignore` | `.env` → `*.env` | 修复 `(2).env`（含真实 key）未被忽略的安全隐患 |

其余 GATE 均为**只读审计**，未修改代码。FROZEN 47 文件零接触。
