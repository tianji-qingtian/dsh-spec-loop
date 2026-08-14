# dsh-spec-loop

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的规格驱动开发闭环：`/spec` 命令族驱动 **生成规格 → 批准 → 按任务实现 → 对照验收 → 归档**，变更目录与 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 格式兼容，位于 `<工作区>/openspec/` 下。

> Harness 仍处于 developer preview，迭代很快，可能出现破坏性变更。

> English version: [README.md](README.md)。

## 特性

- **`/spec` 命令族** — `init` · `new <目标>` · `list` · `show <id>` · `approve <id>` · `implement <id>` · `verify <id> [--deep]` · `archive <id>` · `validate [id]` · `edit <id>`。命令只做流程编排与文件操作，提案/实现内容由 agent 主模型经 `agent.steer` 用完整工具集生成。
- **`/spec new` 澄清提问** — 最多 3 个内置选择题（范围 / 约束 / 验收方式），随目标语言中英切换，走 harness 问答 UI；子代理会话或缺少 UI provider 时自动跳过澄清。
- **OpenSpec 兼容目录** — `openspec/project.md`、`openspec/specs/<能力>/spec.md`、`openspec/changes/<change-id>/{proposal.md,tasks.md,design.md,verify.md,specs/<cap>/spec.md}`，归档到 `changes/archive/YYYY-MM-DD-<id>/`；规格增量用 `## ADDED|MODIFIED|REMOVED Requirements`，每条 Requirement 至少一个 `#### Scenario:`。
- **内置校验器** — 与 OpenSpec CLI 同款核心规则（增量节、Requirement、Scenario、change-id 格式），提案生成后自动校验，失败则把修正请求 steer 回 agent（带重试上限）；`approve` 拒绝未通过校验的变更，`archive` 拒绝不存在的变更。
- **批准门** — `implement` 拒绝状态不是 `approved`（或实现链后续阶段）的变更。门禁读的是面板渲染的同一个持久投影，显示态与行为态永不打架。
- **逐 Scenario 验收** — `verify` 用受限裁判调用逐条判定（默认 flash，`--deep` 升级主模型），先跑 `proposal.md` 里 ```` ```bash ```` 声明的验证命令，再产出 `verify.md`（✅/❌ 表格 + 原始判定输出）。
- **持久状态机** — `proposed → approved → implemented → verified → archived`（任何阶段可 `edit` 回 `proposed`）由会话投影折叠标准事件（`command/run`/`command/done` 对 + agent 的机器标记），变更卡、阶段、门禁重启不丢；不向日志写任何自定义事件类型。
- **输入框上方变更卡** — `conversation.input.dock` 全宽行显示当前 change-id、阶段、任务进度 `x/y` 与下一步命令；进度读标准 `todos` 投影（implement 提示词让 agent 把 tasks.md 镜像进 `todo_write`），零 RPC；文案走 `locale` 服务中英双语。

## 安装

### 前置条件

`dsh` CLI 必须在 `PATH` 上。如果之前只通过 `npx` 跑过 harness，先全局安装：

```sh
npm install -g @deepseek-ai/dsh
```

`pnpm add -g @deepseek-ai/dsh` 也可以（前提是 pnpm 的全局 bin 目录在 `PATH` 上）；或者不装全局，给下面命令加 `npx @deepseek-ai/dsh …` 前缀。

### 添加 bundle

```sh
# 1. 把 bundle 加进 web profile（pnpm 拉取；lib/ 产物已提交在仓库里，
#    安装时不需要跑构建）。优先用 release tag（#v0.1.0）；#main 跟最新提交。
dsh plugin --profile web add "github:tianji-qingtian/dsh-spec-loop#v0.1.0"

# 2. 用该 profile 重启 harness —— add 只改 profile 文件，运行中的实例不会热加载
dsh --profile web
```

重启后输入框上方出现 📐 Spec 变更卡，host 端加载后 `/spec` 命令注册完成。可在 Settings → Plugins 里确认 `dsh-spec-loop` 已列出。

## 用法

```sh
/spec init                          # 生成 openspec/project.md 与目录结构
/spec new 用户登录功能               # 澄清 → agent 生成提案/任务/增量 → 自动校验
/spec list                          # 活跃变更（任务 x/y）+ 能力规格
/spec show add-user-login           # 查看提案全文（含 design.md）
/spec approve add-user-login        # 批准 → 打开实现门
/spec implement add-user-login      # agent 按 tasks.md 逐项实现并勾选
/spec verify add-user-login         # 逐 Scenario 验收（flash）；--deep 用主模型
/spec verify add-user-login --deep
/spec archive add-user-login        # 合并增量进 specs/，移入 changes/archive/
/spec validate [id]                 # OpenSpec 格式校验（/spec new 后自动跑）
/spec edit add-user-login           # 修订提案，回到 proposed
```

输入框上方的变更卡实时显示当前 change-id、阶段、`x/y` 进度与下一步命令。

## 工作原理

| 部分 | 机制 |
|---|---|
| 命令 | `commands.register` —— 一个 `/spec` 命令 + 子命令路由。handler 只做编排与文件操作（`ctx.fs`）；生成任务用 `agent.steer` 注入（plugin 来源的 `UserMessage`） |
| 状态机 | 会话投影（`specLoop`）折叠标准事件：`command/run`+`command/done` 对仅成功后转移，agent 回复里的机器标记（`SPEC_CHANGE_ID: <id>`、`SPEC_IMPLEMENTED`）完成异步阶段收尾；`implement` 门禁读同一投影 |
| 任务进度 | implement 提示词让 agent 把 tasks.md 镜像进 `todo_write`；面板读内置 `todos` 投影 |
| 验收 | handler 内的受限裁判调用（`ctx.llm.stream`、`reasoningEffort: 'off'`、默认 flash）；`proposal.md` 里 ```` ```bash ```` 块先经 `ctx.shell` 执行并纳入裁判输入 |
| 归档合并 | 增量按 Requirement 逐条合并进 `specs/<cap>/spec.md`（ADDED 追加 / MODIFIED 替换 / REMOVED 删除），再经一次 `mv`（`ctx.shell`）移入归档 |
| UI | `conversation.input.dock` slot 条目；读 `useProjection('specLoop')` + `useProjection('todos')`；文案走 `locale` 服务 |

## 兼容性说明

- **不写自定义会话事件类型**。外置插件无法安全注册新 `SessionEventMap` 成员（持久化读路径会拒绝未知非 ignorable 类型），所以所有状态转移都走标准事件——即使插件日后被移除，会话日志依然可读。
- **`ctx.fs` 没有移动/删除**，归档用 `ctx.shell`（`mkdir && mv`）做物理移动；`openspec/` 在工作区内，工作区沙箱放行。
- **批准状态按会话维度**折叠自该会话的命令日志——在一个会话里 approve 不会作用于其他会话。

## 开发

```sh
pnpm install
pnpm build      # tsdown：lib/index.js（host）+ lib/client.js（client bundle）
pnpm test       # 三套测试：mock 运行时单元测试、真实文件系统冒烟、
                # 真实组合集成测试（cordis + 真实 fs/commands/session-projection/llm 服务）
```

需求基线：[REQUIREMENTS.md](./REQUIREMENTS.md)。

## License

MIT
