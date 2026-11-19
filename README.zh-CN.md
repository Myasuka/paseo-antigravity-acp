# paseo-antigravity-acp

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

[English](./README.md) | 简体中文

面向 [Paseo](https://github.com/getpaseo/paseo)（`>=0.15.4`）的独立开源 **Google Antigravity CLI (`agy acp`)** 插件，提供交互式工具权限审批、`realpath` 只读技能目录放行、无损 **Full access** 模式切换、逐模型独立思维档位、异步任务与原生 `/swarm` 跨回合自动接续，以及内置的 **Swarm 实时可视化看板**。

---

## 功能特性

### 1. 交互式权限策略与可配置只读目录
- 仅当所有目标路径经 `realpath` 解析后完全位于允许的只读目录内时，自动放行纯只读工具（`read_file`、`view_file`、`list_dir`、`find_by_name`、`grep_search`），防止软链接或 `..` 路径穿越。
- 内置默认只读 Skills 目录：
  - `~/.agents/skills`
  - `~/.codex/skills`
  - `~/.claude/skills`
  - `~/.gemini/antigravity-cli/builtin/skills`
- 可直接在 Paseo **设置 -> Antigravity ACP 设置**（或环境变量 `PASEO_AGY_EXTRA_READ_ROOTS`）中按行添加额外的文档/技能只读目录，无需修改插件源码。
- 终端命令执行、文件新建/修改、网页访问与 MCP 工具始终严格遵循当前会话的权限模式。

### 2. 原生 Full access 权限边界同步
- Antigravity 的后台唤醒（异步命令、原生子 Agent 与 `/swarm` Worker）在后台独立运行，不经过前台 ACP 权限回调。
- 切换到 **Full access** 时，插件会在空闲态自动携带会话持久化信息重启底层 `agy acp` 并开启 `--dangerously-skip-permissions`；切出 **Full access** 时立即销毁提权进程并恢复标准审批模式。

### 3. 逐模型独立思维档位、原生工具卡片与历史时间戳恢复
- 目录发现阶段自动探测每个模型支持的 `thought_level` 档位（如 `low` / `medium` / `high` / `xhigh`，不支持思维档位的模型自动隐藏选择器）。
- 将 `run_command`、`read_file`、`edit_file`、`write_file`、`grep_search`、`find_by_name`、`search_web`、`read_url_content`、`invoke_subagent`、`manage_subagents`、`send_message` 以及 Swarm 工具（`swarm`、`post_message`、`read_board`、`swarm_wait`）映射为结构化 Paseo 工具详情卡片，并修正命令失败时的工具错误状态展示。
- 在关闭后重开会话（`session/load`）重放历史消息时，自动从本地 Antigravity transcript 读取真实消息与工具完成时间戳注入 `timeline.item.timestamp`；并在桥接层等待 `agy acp` 异步历史回放完全排空后再放行 `session/load` 响应，彻底避免重开长会话时发生消息重复输出及轮次完成时间被改写成当前时间的问题。

### 4. 后台任务与原生 `/swarm` 自动排空接续
- 解决 `agy acp` 在后台异步 `run_command`、`invoke_subagent` 或 `/swarm` Worker 尚未结束时提前返回 `end_turn` 导致消息断流的问题。
- 实时追踪 `.system_generated/logs/transcript.jsonl` 与 `.system_generated/swarm/{members.json,board.jsonl}`：只要仍有非观察类任务型 Worker 处于运行态或存在未消费的留言板唤醒，自动保持 Paseo 回合在线并流式补发后续工具状态、回复正文与增量 Token 统计。
- 自动忽略仅处于驻留监听态的观察角色（`narrator`、`monitor`），防止正常收尾后死锁；在非 Full access 模式下若后台 Worker 因无法弹出审批而卡住，会在超时后给出清晰诊断提示。

### 5. Paseo 内置 Swarm 实时可视化看板
- 提供会话右侧 **Swarm 看板** 面板、Antigravity 会话专属 **Swarm** 输入框动态胶囊、Command Center 快捷动作与 `/swarm-board` 斜杠命令。
- 基于 `etag` 增量缓存的只读快照 RPC，内置四个视图：
  - **总览（Overview）**：系统异常与配额告警（`429` 限流、Worker 报错、长时间无响应）、`plan.json` 目标与任务分组、`view.json` 阶段进度/工作流/里程碑/风险项。
  - **留言板（Board）**：支持关键词搜索、成员筛选标签、`#seq` 消息跳转高亮、`@mention` 标记与一键复制。
  - **成员（Members）**：按 `工作中 -> 等待中 -> 已结束` 排序展示成员模型、角色、步数、发帖数、未读数与当前正在执行的工具或思考摘要。
  - **拓扑图（Graph）**：展示成员间 `@mention` / `@all` / `@#channel` 有向通信权重，并支持 `上一条 / 下一条 / 最新` 消息流逐步回放。
- 同时兼容本插件的 `antigravity-acp` 会话与 Paseo 内置 `antigravity` 会话（无论打开的是 Coordinator 还是任意子 Worker 会话均可自动定位所属 Swarm）。

---

## 环境要求

- **Node.js** `>= 22.6.0`
- **Paseo** `>= 0.15.4`
- 已安装并登录 **Antigravity CLI (`agy`)**（可通过 `agy --version` 验证）

插件按以下优先级自动查找 `agy` 可执行文件：
1. Paseo 插件设置页面配置的自定义路径（`agyPath`）
2. 环境变量 `PASEO_AGY_BIN`
3. 系统 `PATH`
4. 常见默认安装路径（`~/.local/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy`，Windows 下为 `%USERPROFILE%\.local\bin\agy.exe`）

---

## 安装方式

### 方式一：直接从 GitHub 安装

```bash
paseo plugin install git:Myasuka/paseo-antigravity-acp
```

### 方式二：从本地克隆安装

```bash
git clone https://github.com/Myasuka/paseo-antigravity-acp.git
cd paseo-antigravity-acp
npm install
paseo plugin install "$(pwd)"
```

也可以在 `~/.paseo/config.json` 中手动注册本地插件目录：

```json
{
  "plugins": {
    "antigravity-approval": "/absolute/path/to/paseo-antigravity-acp"
  }
}
```

> **说明**：为保持与既有会话及配置无缝兼容，插件清单 ID 保持为 `antigravity-approval`，Provider ID 为 `antigravity-acp`。

---

## 在 Paseo 中使用原生 `/swarm`

1. 使用 **Antigravity · ACP**（`antigravity-acp`）新建或打开会话。
2. 将会话权限模式切换为 **Full access**（确保后台派生的 Swarm Worker 可自动执行工具而不会卡在无界面的后台审批）。
3. 发送 `/swarm <你的复杂并行任务>`（或让 AGY 读取 `swarm` 技能组织多成员协作）。
4. 点击输入框下方的 **Swarm** 状态胶囊（或输入 `/swarm-board`），即可在右侧打开实时刷新的 **Swarm 看板**。

---

## 配置项说明

可在 Paseo **设置 -> Antigravity ACP 设置**（或通过 Command Center 搜索 **配置 Antigravity ACP**）修改：

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `agyPath` | `""`（自动探测） | 自定义 `agy` 可执行文件路径（支持 `~/`）。 |
| `progressUpdates` | `true` | 为多步骤长任务注入简短阶段进度汇报提示。 |
| `backgroundTimeoutMinutes` | `60` | 等待后台任务、子 Agent 或 Swarm Worker 完成的最大超时时间（1–1440 分钟）。 |
| `readOnlyRoots` | `[]` | 额外允许只读/搜索工具自动放行的目录列表（每行一个路径，经 `realpath` 校验）。 |

配置按主机保存在 `~/.paseo/plugin-settings/antigravity-approval/policy.json`。

---

## 开发与测试

```bash
npm run check:sanitize   # 敏感路径、密钥与内部标识扫描门禁
npm run typecheck        # TypeScript 严格类型检查（覆盖服务端、客户端与共享协议）
npm test                 # 运行完整单元测试与 ACP 协议回归测试套件
```

---

## 开源协议

基于 [Apache License 2.0](./LICENSE) 开源发布。
