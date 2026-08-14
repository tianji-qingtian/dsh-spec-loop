# dsh-spec-loop — 需求文档

> 状态：待开发。本文件是需求基线，新的对话里按这份开工。

## 一句话目标

把 **Spec-driven development（规格驱动开发）** 搬到 DeepSeek Harness 里：`/spec` 命令族驱动「**生成规格 → 批准 → 按任务实现 → 对照规格逐条验收 → 归档**」的完整闭环，规格文件与 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 目录格式兼容。

## 调研结论（为什么是这个形态）

| 方案 | 核心机制 | 结论 |
|---|---|---|
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | 三阶段工作流：提案（`proposal.md` + `tasks.md` + 可选 `design.md` + 规格增量）→ 批准后实现 → 归档；规格增量用 `## ADDED/MODIFIED/REMOVED Requirements` + `#### Scenario:` 表达 | ✅ **采用其目录格式与三阶段流程**；不依赖其 CLI，校验器插件自实现 |
| [GitHub spec-kit](https://github.com/github/spec-kit) | `/constitution → /specify → /plan → /tasks → /implement`，每个阶段产出 Markdown 喂给下一阶段，12 万 star、35 种 agent 集成 | 思路一致（命令驱动的阶段机）；v1 只兼容 OpenSpec 格式，spec-kit 作为后续扩展 |
| Amazon Kiro | IDE 内嵌 spec-first 所有权 | 参考其"规格即契约"定位，不移植 |

**关键架构决策**：命令只做**流程编排 + 文件系统操作**；提案/实现/验收的**内容生成全部交给 agent 主模型**（命令 handler 用 `agent.steer/inject` 把结构化任务注入 inbox，让 agent 用完整工具集执行）。原因：生成质量要高（主模型）、要能读写文件（agent 的 fs 工具）、命令实现保持简单。

## 用户故事

1. 用户说"我想做一个 X 功能" → 输 `/spec new X`
2. 插件问 1-3 个澄清问题（内置选择框，中英随提问语言）
3. agent 在 `openspec/changes/<change-id>/` 下生成 `proposal.md`、`tasks.md`、规格增量，插件自动校验格式
4. 面板（输入框上方 dock）显示当前变更卡：change-id、阶段、任务进度 x/y
5. 用户审阅后 `/spec approve <id>` → 才允许实现（**不批准不实现**）
6. `/spec implement <id>` → agent 按 tasks.md 逐项实现并勾选 checklist
7. `/spec verify <id>` → 对照规格逐条验收（每条 Requirement 的每个 Scenario），产出 `verify.md` 报告（✅/❌ + 差异）
8. `/spec archive <id>` → 移入 `changes/archive/`，更新 `specs/`

## 命令族（v1）

| 命令 | 行为 |
|---|---|
| `/spec init` | 初始化 `openspec/project.md` + 目录结构 |
| `/spec new <一句话目标>` | 澄清（≤3 问，`ctx.userQuestions.ask`）→ steer agent 生成提案 → 自动 `validate` → 状态 proposed |
| `/spec list` | 列出活跃变更与能力规格（读目录，纯文本输出） |
| `/spec show <id>` | 展示某个提案全文 |
| `/spec approve <id>` | 状态 → approved（实现前置门） |
| `/spec implement <id>` | steer agent：读提案按 tasks 逐项实现（用 todo 跟踪）、完成后勾 checklist；未 approved 时拒绝并提示 |
| `/spec verify <id>` | 逐 Scenario 验收（默认 flash 静态核对；`--deep` 用主模型）→ `verify.md` |
| `/spec archive <id>` | 移入 `changes/archive/YYYY-MM-DD-<id>/`，合并 specs 增量 |
| `/spec validate [id]` | 格式校验（增量节、Scenario 存在性、id 唯一性） |

## 状态机（投影持久化，跨重启保持）

```
proposed --approve--> approved --implement--> implemented --verify--> verified --archive--> archived
   └──（任何阶段可 /spec edit 回到 proposed 修改提案）
```

状态、当前 change-id、任务进度（x/y）由 `sessionProjections` 投影折叠 `/spec` 的 `command/run` 事件 + 插件写入的状态事件——沿用 model-router "显示态与行为态都走投影"的教训，重启不丢。

## 目录/文件格式（OpenSpec 兼容）

```
<工作区>/openspec/
├── project.md                  # 项目约定（/spec init 生成）
├── specs/<capability>/spec.md  # 能力规格（Requirements + Scenarios）
└── changes/
    ├── <change-id>/            # 活跃变更：add-foo / update-bar（kebab-case、verb 开头）
    │   ├── proposal.md         # Why / What Changes / Impact
    │   ├── tasks.md            # `- [ ]` 清单（实现进度源）
    │   ├── design.md           # 可选：技术决策
    │   ├── verify.md           # 插件产出：逐 Scenario 验收报告
    │   └── specs/<cap>/spec.md # 规格增量：## ADDED/MODIFIED/REMOVED Requirements
    └── archive/YYYY-MM-DD-<change-id>/
```

规格增量必须每条 Requirement 至少带一个 `#### Scenario:`（OpenSpec 校验规则，插件自实现同款检查）。

## 关键契约（已确认，全部现成）

- **命令编排**：`commands.register`（`CommandDefinition`），handler 拿 `CommandInvocation { agent, rawInput, signal }`；**把生成任务交给 agent**：`agent.steer(UserMessage)`（wake next-step）或 `agent.inject`（不唤醒）；命令返回 `{ kind: 'success', text }` 作为即时反馈
- **澄清问题**：`ctx.userQuestions.ask({ questions, agent, signal })` → `{ answers: [{ id, selected[] }] }`；子代理自动抛 `DELEGATED_CALLER` 需捕获回退（model-router v0.8.0 已验证）
- **文件系统**：`ctx.fs`（`resolve/readText/writeText/listDir`），spec 目录在工作区 `openspec/` 下；agent 侧用其原生 read/write/edit/glob/grep 工具
- **状态持久化**：`sessionProjections.register`（折叠 `command/run` 事件 → 状态/进度/当前 id）
- **进度 UI**：`conversation.input.dock`（全宽行，session scope，标准 props 含 `useProjection`/`sessionId`）
- **i18n**：`locale` 服务（`zh`/`en`），命令 hint/描述、面板文案
- **验收模型调用**：`ctx.llm.stream`（flash + `reasoningEffort: 'off'`，maxTokens 充足；`--deep` 走主模型）——沿用 model-router 的裁判调用经验（block-end 收集文本）
- **实现阶段长任务**：可选 `goals` 服务或 `todo_write` 跟踪（v1 用 tasks.md checklist 即可）
- **打包**：照抄 model-router（`dsh.bundle.patch` + `dsh.client` + tsdown 双产物）；Client→Host 用命令 remote 时**必须硬注入 `remote`/`remote.commands`**（v0.7.1 教训）

## 核心提示词（草案，需打磨）

**提案生成**（steer 给 agent 的任务模板）：

```
You are creating an OpenSpec change proposal in <cwd>/openspec/changes/<change-id>/.
Read openspec/project.md and openspec/specs/ first. Produce:
1. proposal.md — Why / What Changes / Impact sections
2. tasks.md — ordered `- [ ]` implementation checklist (no nested bullets)
3. specs/<capability>/spec.md — deltas with `## ADDED Requirements` (or
   MODIFIED/REMOVED) and at least one `#### Scenario:` per requirement
Do not start implementing. Report the change-id and a one-line summary.
```

**验收**（`/spec verify` 的 flash 调用，逐条）：

```
You are verifying implementation against a spec. For each Requirement and
each Scenario below, judge whether the workspace implementation satisfies
it. Read the relevant files. Output one line per scenario:
OK|FAIL <requirement>: <scenario> — <one-line reason>
Spec: <deltas + scenario 列表>
```

（`verify.md` 由命令 handler 汇总成 ✅/❌ 表格；测试类 Scenario 通过 proposal 里声明的验证命令跑 `bash` 确认。）

## 验收清单（本插件开发完的自检）

- [ ] `/spec init` 后目录结构正确
- [ ] `/spec new 一个功能` 走完澄清 → 提案 → 自动校验，文件符合 OpenSpec 格式
- [ ] 未 approve 时 `/spec implement` 被拒绝
- [ ] approve → implement 后 tasks.md 全部勾选，面板进度 x/y 同步
- [ ] verify 产出 verify.md，✅/❌ 与代码事实一致（含一个故意不满足的 Scenario 能测出 ❌）
- [ ] archive 后目录移动正确、specs/ 合并正确
- [ ] 重启 dsh 后当前变更卡与阶段仍在（投影持久化）
- [ ] 中英双语（命令提示、面板、澄清问题随提问语言）
- [ ] 不与已有 `/plan`（DSH 内置）命令冲突（名字用 `/spec`）

## 待定项（开工时拍板）

1. 插件名：`dsh-spec-loop` vs `dsh-openspec`（建议前者，突出"闭环"）
2. `verify` 默认模型：flash（快）vs 主模型（准）——建议默认 flash + `--deep` 升级
3. 是否监听 `fs/write-intent` 强制"未 approve 不改实现相关文件"？v1 不做（只做命令级门），留 v2
4. spec-kit 格式兼容是否进 v1（建议不进）
5. 面板放 `conversation.input.dock`（一行变更卡）是否够用，还是要加设置页

## 参考实现

- model-router：命令编排（`/router`）、flash 零前缀调用（`answerOnCheap`/`flashJudge`）、投影持久化（`modelRouter` unit）、`ask_user_question`（v0.8.0）、remote 硬注入（v0.7.1）、双语文档与 locale
- composer-polish（用户自建）：输入框侧按钮与 commands remote 往返
- 容器 README「开发心得」：event.data、不相交计数、thinking 预算、进程态 vs 投影持久态等全部适用

## 参考链接

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) 及 [AGENTS.md 工作流](https://github.com/Fission-AI/OpenSpec/blob/2e51ae26d3ab51ea18c2a3c81230d52cc74abe3c/openspec/AGENTS.md)
- [GitHub spec-kit](https://github.com/github/spec-kit) 及 [SDD 文档](https://github.com/github/spec-kit/blob/main/docs/index.md)
