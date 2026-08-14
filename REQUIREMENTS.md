# dsh-spec-loop — 需求文档

> 状态：✅ 已发布。仓库 [tianji-qingtian/dsh-spec-loop](https://github.com/tianji-qingtian/dsh-spec-loop)，最新 [v0.1.2](https://github.com/tianji-qingtian/dsh-spec-loop/releases/tag/v0.1.2)。本文件保留为需求基线与开发记录，新功能按 spec-loop 自身的流程走 `openspec/changes/` 提案。

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

## 命令族（已实现）

| 命令 | 行为 | 版本 |
|---|---|---|
| `/spec init` | 初始化 `openspec/project.md` + 目录结构 | v0.1.0 |
| `/spec new <一句话目标>` | 澄清（≤3 问，`ctx.userQuestions.ask`）→ steer agent 生成提案 → 完成后自动 `validate`（失败 steer 修正）→ 状态 proposed | v0.1.0 |
| `/spec status` | 只读变更卡：当前 change-id、阶段、x/y 进度与下一步命令（specLoop + todos 投影，不改任何状态） | v0.1.1 |
| `/spec list` | 列出活跃变更与能力规格（读目录，纯文本输出） | v0.1.0 |
| `/spec show <id>` | 展示某个提案全文（含 design.md） | v0.1.0 |
| `/spec approve <id>` | 校验通过后状态 → approved（实现前置门） | v0.1.0 |
| `/spec implement <id>` | steer agent：读提案按 tasks 逐项实现（todo_write 镜像 tasks.md 跟踪）、完成后勾 checklist；未 approved 时拒绝并提示 | v0.1.0 |
| `/spec verify <id> [--deep]` | 逐 Scenario 验收（默认 flash，`--deep` 用主模型）→ `verify.md`；proposal.md 里声明的 ```bash 验证命令先执行 | v0.1.0 |
| `/spec archive <id>` | 合并 specs 增量（ADDED 追加/MODIFIED 替换/REMOVED 删除）→ 移入 `changes/archive/YYYY-MM-DD-<id>/` | v0.1.0 |
| `/spec validate [id]` | 格式校验（增量节、Requirement、Scenario 存在性、change-id 格式） | v0.1.0 |
| `/spec edit <id>` | steer agent 修订提案 → 状态回到 proposed（需重新 approve） | v0.1.0 |

## 状态机（投影持久化，跨重启保持）

```
proposed --approve--> approved --implement--> implemented --verify--> verified --archive--> archived
   └──（任何阶段可 /spec edit 回到 proposed 修改提案）
```

实现（与需求草案不同，见"开发期决策"第 1 条）：状态与当前 change-id 由 `specLoop` 投影**只折叠标准事件**——`command/run` + `command/done` 对（仅成功时转移，失败不转移）+ agent 回复里的机器标记（`SPEC_CHANGE_ID: <id>`、`SPEC_IMPLEMENTED`）；任务进度 x/y 由客户端读内置 `todos` 投影（implement 提示词让 agent 把 tasks.md 镜像进 `todo_write`）。重启不丢。

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
- **实现阶段长任务**：可选 `goals` 服务或 `todo_write` 跟踪（v1 用 tasks.md checklist + todo_write 镜像）
- **打包**：照抄 model-router（`dsh.bundle.patch` + `dsh.client` + tsdown 双产物）；Client→Host 用命令 remote 时**必须硬注入 `remote`/`remote.commands`**（v0.7.1 教训）

## 核心提示词（已实现并验证）

**提案生成**（steer 给 agent 的任务模板）：

```
You are creating an OpenSpec change proposal in <cwd>/openspec/changes/<change-id>/.
Read openspec/project.md and openspec/specs/ first. Produce:
1. proposal.md — Why / What Changes / Impact sections
2. tasks.md — ordered `- [ ]` implementation checklist (no nested bullets)
3. specs/<capability>/spec.md — deltas with `## ADDED Requirements` (or
   MODIFIED/REMOVED) and at least one `#### Scenario:` per requirement
Do not start implementing. Report the change-id and a one-line summary.
End your reply with: SPEC_CHANGE_ID: <change-id>   ← 机器标记，投影靠它收尾
```

**验收**（`/spec verify` 的 flash 调用，逐条）：

```
You are verifying implementation against a spec. For each Requirement and
each Scenario below, judge whether the workspace implementation satisfies
it. Read the relevant files. Output one line per scenario:
OK|FAIL <requirement>: <scenario> — <one-line reason>
Spec: <deltas + scenario 列表>
```

（`verify.md` 由命令 handler 汇总成 ✅/❌ 表格；测试类 Scenario 通过 proposal 里声明的 ```bash 验证命令跑 `ctx.shell` 确认。）

## 验收清单（自检结果）

- [x] `/spec init` 后目录结构正确 — 真实文件系统冒烟测试 + 实机验证
- [x] `/spec new 一个功能` 走完澄清 → 提案 → 自动校验，文件符合 OpenSpec 格式 — 单测覆盖澄清/steer/自动校验 steer 修正；实机演示通过真实校验器
- [x] 未 approve 时 `/spec implement` 被拒绝 — 单测覆盖门禁
- [x] approve → implement 后 tasks.md 全部勾选，面板进度 x/y 同步 — 实机演示（add-spec-status 变更）按协议勾选 6/6；面板读 todos 投影
- [x] verify 产出 verify.md，✅/❌ 与代码事实一致（含一个故意不满足的 Scenario 能测出 ❌）— 单测用 FAIL 判定验证
- [x] archive 后目录移动正确、specs/ 合并正确 — 真实文件系统测试（真 mv + 合并断言）
- [x] 重启 dsh 后当前变更卡与阶段仍在（投影持久化）— 投影只折叠持久化日志的标准事件，折叠逻辑单测覆盖
- [x] 中英双语（命令提示、面板、澄清问题随提问语言）— locale 字典 + 语言检测，单测覆盖
- [x] 不与已有 `/plan`（DSH 内置）命令冲突（名字用 `/spec`）

## 待定项（已拍板）

1. 插件名：✅ `dsh-spec-loop`（突出"闭环"）
2. `verify` 默认模型：✅ 默认 flash + `--deep` 升级主模型（flash 关 thinking，deep 保留默认 reasoning）
3. 是否监听 `fs/write-intent` 强制"未 approve 不改实现相关文件"？✅ v1 不做（只做命令级门），留 v2
4. spec-kit 格式兼容是否进 v1？✅ 不进
5. 面板放 `conversation.input.dock`（一行变更卡）是否够用？✅ 够用，不加设置页；对齐修复见 v0.1.2

## 开发期决策（实现时拍板，偏离草案处）

1. **不写自定义会话事件**（重要）。外置插件无法安全注册新 `SessionEventMap` 成员——持久化读路径会拒绝未知的非 ignorable 类型（写进去会话日志就废了）。所以状态机全部转移走**标准事件**：`command/run`+`command/done` 对 + agent 消息里的机器标记。草案里"插件写入的状态事件"改为此方案。
2. **`ctx.fs` 没有 move/delete**。归档的物理移动用 `ctx.shell`（`mkdir && mv`）；`writeText` 会自动递归建父目录（创建路径无需 mkdir）。
3. **`resolve('')` 抛 `FS_NOT_FOUND`**（本地后端拒绝空路径）。verify 收集工作区文件从 `'.'` 开始列目录——mock 测试测不出，真实组合测试暴露的。
4. **fs 观察策略只拦工具层**。`fs/write-intent` 瀑布由 dsh-tool-fs 派发（actor=工具执行上下文）；插件直调 `ctx.fs.writeText` 不带 expected 即无条件写，不受"先读后写"策略影响。沙箱后端默认围栏在工作区内放行。
5. **dock 条目对齐要用主题 CSS 变量**：`--dsh-composer-side-clearance` / `--dsh-composer-card-max-width` / `--dsh-composer-dock-inset`（官方 queue/todo 条目同款公式），否则卡片贴到页面最左（v0.1.2 修复）。
6. **pnpm 11 构建审批**：`allowBuilds` 要写在 `pnpm-workspace.yaml`（package.json 的 `pnpm` 字段已不被读取）；koffi（dsh-fs-local 传递依赖）需批准，否则 CI install 直接失败。
7. **归档合并策略**：ADDED 追加 / MODIFIED 按 Requirement 名替换（不存在则追加）/ REMOVED 删除同名块；新建 spec 自动带 `# <Cap> Specification` 头。

## 版本历史

| 版本 | 变更 |
|---|---|
| v0.1.0 | 初版：`/spec` 命令族（init/new/list/show/approve/implement/verify/archive/validate/edit）、specLoop 投影状态机、dock 变更卡、校验器、归档合并 |
| v0.1.1 | 新增 `/spec status`（只读变更卡，spec-loop 流程产出的第一个变更：openspec/changes/add-spec-status） |
| v0.1.2 | dock 变更卡与聊天框左边缘对齐（主题 CSS 变量公式） |

## 参考实现

- model-router：命令编排（`/router`）、flash 零前缀调用（`answerOnCheap`/`flashJudge`）、投影持久化（`modelRouter` unit）、`ask_user_question`（v0.8.0）、remote 硬注入（v0.7.1）、双语文档与 locale
- composer-polish（用户自建）：输入框侧按钮与 commands remote 往返
- 容器 README「开发心得」：event.data、不相交计数、thinking 预算、进程态 vs 投影持久态等全部适用

## 参考链接

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) 及 [AGENTS.md 工作流](https://github.com/Fission-AI/OpenSpec/blob/2e51ae26d3ab51ea18c2a3c81230d52cc74abe3c/openspec/AGENTS.md)
- [GitHub spec-kit](https://github.com/github/spec-kit) 及 [SDD 文档](https://github.com/github/spec-kit/blob/main/docs/index.md)
