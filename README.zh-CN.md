# Ralph CLI 中文说明

Ralph CLI 是一个面向 PRD 驱动开发的轻量命令行工具：`PRD -> ralph start -> 自动执行 -> finalize`。

配套项目：[Ralph MCP](https://github.com/G0d2i11a/ralph-mcp) 把同一套 Ralph 工作流暴露成 Claude Code 里的 MCP 工具。需要独立命令行 manager、launchd 重启、lease/revision 恢复和独立 integration worktree 时，用 Ralph CLI；需要在 Claude Code/MCP 对话里执行 `ralph_start` / `ralph_status` 时，用 Ralph MCP。

## 快速开始

```bash
# 当前推荐源码安装
npm install
npm run build
npm link

ralph start ./my-prd.json
ralph status
ralph list

# 给不同项目使用独立 Ralph Home
ralph --home ~/.ralph-homes/my-project start ./my-prd.json
```

## 常用命令

```bash
ralph [--home <path>] start <prd-path> [--repo <path>] [--agent codex|claude] [--backend cli|agent-runners]
ralph batch-start prds/*.json
ralph watch --auto-ingest-ez4ielts
ralph status <task-id> --detailed
ralph update <task-id> --story-id US-001 --passes
ralph update <task-id> --story-id US-001 --notes "done"
ralph stats <task-id>
ralph stats --all
ralph finalize <task-id>
```

## Ralph Home 隔离

现在 Ralph 支持显式的控制面目录：

```bash
ralph --home ~/.ralph-homes/app-a queue
RALPH_HOME=~/.ralph-homes/app-b ralph manager
```

解析优先级：

1. `--home <path>`
2. `RALPH_HOME`
3. 默认 `~/.ralph`

每个 Ralph Home 都拥有独立的：

- `config.json`
- `tasks/`
- `manager/state.json`
- `manager.lock`
- `scheduler.lock`
- `locks/`
- `logs/`
- queue 视图
- `runner.maxConcurrent`

这也是同一台机器上让两个不同 repo 干净隔离、同时继续共用同一个 Ralph CLI 二进制的推荐方式。

例如：

```bash
ralph --home ~/.ralph-homes/app-a manager --repo ~/Code/app-a
ralph --home ~/.ralph-homes/app-b manager --repo ~/Code/app-b
```

这两个 manager 会各自使用自己的 state 和 lock，可以并行运行。

## PRD 格式

支持两种格式：

- `JSON`：直接提供 `id`、`title`、`description`、`userStories`、`dependencies`
- `Markdown`：支持 frontmatter 里的 `userStories` 数组；也支持正文里的 `## US-001: Title` / `### US-001: Title` 段落格式

## 说明

- Ralph 会把任务状态保存在 `RALPH_HOME/tasks/<task-id>/`，默认仍然是 `~/.ralph/tasks/<task-id>/`
- Ralph 会为每个任务维护一个标准化的 `prd.json` 快照，供 `status --detailed`、`update`、`stats` 使用
- 在最终提交前，如果项目里存在 `typecheck`、`lint`、`build` 脚本，Ralph 会自动运行这些质量门禁
- 默认 backend 是 `cli`；如需统一 runner，请传 `--backend agent-runners` 或配置 `agent.backend`。兼容场景下仍可继续传 `sdk-runner`
- 如果本机的 `agent-runners` 不在默认位置，请设置 `RALPH_AGENT_RUNNERS_CLI` 或 `agent.agentRunnersPath`；旧的 `RALPH_SDK_RUNNER_CLI` / `agent.sdkRunnerPath` 也仍然可用
- 启用 auto-ingest 时，需要显式提供 `--ez4ielts-dir`、`RALPH_EZ4IELTS_WATCH_DIR` 或 `RALPH_HOME/config.json` 里的 `ingestion.ez4ielts.watchDir`
- `runner.pollInterval` 在配置文件里按秒读取；CLI 的 `--interval` 仍然使用毫秒
- `runner.stagnationTimeout` 现在按秒生效，用于把长时间没有进展的 worker 标记为 stagnant
- unattended auto-merge 默认使用 `merge.strategy=manual`；遇到 Git 冲突时，Ralph 会记录 `mergeConflictFiles`、integration worktree 和 repair attempt，并把任务带着专门的 merge repair context 送回修复，而不是静默使用 `ours/theirs` 覆盖其中一边。`ours/theirs` 只适合显式人工 merge，除非你主动设置 `merge.allowDestructiveAutoResolve=true`
- 当前还没有内建通知发送能力，因此生成的配置里不会包含 `notification` 配置块
- `manager-install` 在默认 home 下仍使用 `com.ralph.manager`；如果使用自定义 Ralph Home，会自动生成带 hash 的稳定 label，并把日志写到 `<RALPH_HOME>/logs/`
- Ralph MCP 也支持 Codex/Claude provider 和 PRD watch；两边机制独立，建议按入口选择一个控制面管理同一批任务

更完整的英文文档见 `README.md`。
