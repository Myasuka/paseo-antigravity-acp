# Antigravity ACP（Paseo 插件）

通过官方 `agy acp` 协议将 Google Antigravity 深度接入 Paseo：支持交互式工具权限审批、显式 **Full access** 原生重连、按模型独立思维档位、异步命令与原生 `/swarm` 跨回合自动接续，以及内置的 **Swarm 实时可视化看板**。

## 核心能力

- **交互式权限审批与安全只读目录**：对终端命令、文件写入/编辑、网页抓取与 MCP 调用弹出 Paseo 原生审批卡片；同时对经 `realpath` 真实路径防越界校验的默认 Skills 目录（`~/.agents/skills`、`~/.codex/skills`、`~/.claude/skills`、`~/.gemini/antigravity-cli/builtin/skills`）及插件设置中的自定义只读目录自动放行读取与搜索。
- **显式 Full access 无损切换**：进出 Full access 时自动在会话空闲态重启底层 `agy acp` 进程并同步 `--dangerously-skip-permissions`，既让后台子 Agent 与 Swarm Worker 顺畅运行，又杜绝退出 Full access 后残留提权进程。
- **逐模型独立思维档位**：在目录发现阶段自动探测每个 Antigravity 模型的 `thought_level` 档位（如 `xhigh` / 无档位模型自动隐藏）。
- **异步任务与原生 `/swarm` 自动接续**：当前台回合提前返回而后台 `run_command`、`invoke_subagent` 或 `/swarm` 任务型 Worker 仍在运行时，自动保持 Paseo 回合在线并补齐后续回复、工具卡片与 Token 统计，同时避免 `narrator` / `monitor` 观察角色造成误阻塞。
- **内置 Swarm 实时看板**：直接在 Paseo 会话侧栏、输入框状态胶囊、Command Center 或 `/swarm-board` 打开 Swarm 面板，查看 **总览（Overview）**、**留言板（Board）**、**成员（Members）** 与 **@mention 通信拓扑及回放（Graph）**，同时兼容 `antigravity-acp` 与 Paseo 内置 `antigravity` 会话。
