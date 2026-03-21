# Ralph CLI 中文说明

Ralph CLI 是一个面向 PRD 驱动开发的轻量命令行工具：`PRD -> ralph start -> 自动执行 -> finalize`。

## 快速开始

```bash
# 当前推荐源码安装
npm install
npm run build
npm link

ralph start ./my-prd.json
ralph status
ralph list
```

## 常用命令

```bash
ralph start <prd-path> [--repo <path>] [--agent codex|claude] [--backend cli|sdk-runner]
ralph batch-start prds/*.json
ralph watch --auto-ingest-ez4ielts
ralph status <task-id> --detailed
ralph update <task-id> --story-id US-001 --passes
ralph update <task-id> --story-id US-001 --notes "done"
ralph stats <task-id>
ralph stats --all
ralph finalize <task-id>
```

## PRD 格式

支持两种格式：

- `JSON`：直接提供 `id`、`title`、`description`、`userStories`、`dependencies`
- `Markdown`：支持 frontmatter 里的 `userStories` 数组；也支持正文里的 `## US-001: Title` / `### US-001: Title` 段落格式

## 说明

- Ralph 会把任务状态保存在 `~/.ralph/tasks/<task-id>/`
- Ralph 会为每个任务维护一个标准化的 `prd.json` 快照，供 `status --detailed`、`update`、`stats` 使用
- 在最终提交前，如果项目里存在 `typecheck`、`lint`、`build` 脚本，Ralph 会自动运行这些质量门禁
- 默认 backend 是 `cli`；如需旧的统一 runner，请传 `--backend sdk-runner` 或配置 `agent.backend`
- 如果本机的 sdk-runner 不在默认位置，请设置 `RALPH_SDK_RUNNER_CLI` 或 `agent.sdkRunnerPath`
- 启用 auto-ingest 时，需要显式提供 `--ez4ielts-dir`、`RALPH_EZ4IELTS_WATCH_DIR` 或 `ingestion.ez4ielts.watchDir`
- `runner.pollInterval` 在配置文件里按秒读取；CLI 的 `--interval` 仍然使用毫秒
- `runner.stagnationTimeout` 现在按秒生效，用于把长时间没有进展的 worker 标记为 stagnant
- 当前还没有内建通知发送能力，因此生成的配置里不会包含 `notification` 配置块

更完整的英文文档见 `README.md`。
