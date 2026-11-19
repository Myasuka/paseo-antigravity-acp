# paseo-antigravity-acp

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

English | [简体中文](./README.zh-CN.md)

A standalone [Paseo](https://github.com/getpaseo/paseo) plugin (`>=0.15.4`) that integrates **Google Antigravity CLI (`agy acp`)** with interactive tool approvals, canonical read-only skill policies, lossless **Full access** switching, per-model thinking levels, autonomous background & `/swarm` turn continuation, and a native **Swarm Board** visualizer.

---

## Features

### 1. Interactive Permission Policy & Configurable Read-Only Roots
- Automatically approves strictly read-only file/search tools (`read_file`, `view_file`, `list_dir`, `find_by_name`, `grep_search`) **only** when every target resolves via `realpath` inside allowed read-only directories.
- Built-in default read-only skill roots:
  - `~/.agents/skills`
  - `~/.codex/skills`
  - `~/.claude/skills`
  - `~/.gemini/antigravity-cli/builtin/skills`
- Add extra read-only documentation or skill roots directly in **Settings -> Antigravity ACP** (or via `PASEO_AGY_EXTRA_READ_ROOTS`), without touching source files.
- Shell execution, file writes/edits, web fetches, and MCP calls always follow your active Paseo permission mode.

### 2. Native Full Access Synchronization
- Antigravity's autonomous background wakeups (background tasks, `invoke_subagent`, and `/swarm` workers) run outside the foreground ACP permission callback.
- Entering **Full access** reopens the idle `agy acp` session with `--dangerously-skip-permissions` while preserving conversation persistence; leaving **Full access** immediately terminates the elevated driver and reopens in standard approval mode.

### 3. Per-Model Thinking Options, Rich Tool Cards & History Timestamps
- Automatically probes each model's `thought_level` options during catalog discovery (`low` / `medium` / `high` / `xhigh`, or hides the selector on models without thinking levels).
- Maps Antigravity tool calls (`run_command`, `read_file`, `edit_file`, `write_file`, `grep_search`, `find_by_name`, `search_web`, `read_url_content`, `invoke_subagent`, `manage_subagents`, `send_message`, `swarm`, `post_message`, `read_board`, `swarm_wait`) into native Paseo tool detail cards, and marks failed tool outputs accurately even when ACP reports `completed`.
- Restores original message and tool completion timestamps from local Antigravity transcripts when reopening closed sessions via `session/load`, and drains asynchronous `agy acp` `session/load` history replay before releasing the load response so reopened long sessions never append duplicate output or overwrite turn completion timestamps.

### 4. Background & Native `/swarm` Turn Continuation
- Bridges the gap when `agy acp` returns `end_turn` before asynchronous `run_command` tasks, `invoke_subagent` runs, or native `/swarm` workers finish.
- Tails `.system_generated/logs/transcript.jsonl` and `.system_generated/swarm/{members.json,board.jsonl}` to keep the Paseo turn active while task workers are working or coordinator board wakeups are pending, streaming follow-up tool calls, messages, and token usage back to Paseo.
- Excludes observer-only Swarm roles (`narrator`, `monitor`) from blocking turn completion once all task workers settle, and surfaces clear timeout diagnostics if a non-`Full access` background worker stalls on an unroutable native approval.

### 5. Live Paseo Swarm Board Visualizer
- Adds an **Antigravity Swarm Board** agent panel, a live **Swarm** composer pill on Antigravity sessions, a Command Center action, and the `/swarm-board` slash command.
- Four interactive tabs powered by an `etag`-cached read-only snapshot RPC:
  - **Overview**: System attention alerts (rate-limit/quota `429`, worker errors, stuck workers), `plan.json` goal & work threads, and `view.json` phase/workstreams/milestones/risks.
  - **Board**: Searchable shared message board with member filter chips, `#seq` anchor jumps, `@mention` badges, and one-click copy.
  - **Members**: Live roster sorted by state (`active` -> `waiting` -> `killed`) with model/role badges, step & post counters, unread counts, and current tool/thinking activity.
  - **Graph**: Directed `@mention` / `@all` / `@#channel` communication topology with an interactive `Prev / Next / Live` message flow replay stepper.
- Works seamlessly with **both** `antigravity-acp` sessions and Paseo's built-in `antigravity` provider sessions, whether viewing the coordinator or an individual worker conversation.

---

## Prerequisites

- **Node.js** `>= 22.6.0`
- **Paseo** `>= 0.15.4`
- **Antigravity CLI (`agy`)** installed and authenticated (`agy --version`)

The plugin resolves `agy` in the following order:
1. Custom executable path set in **Settings -> Antigravity ACP**
2. `PASEO_AGY_BIN` environment variable
3. `PATH` lookup
4. Standard install locations (`~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, or `%USERPROFILE%\.local\bin\agy.exe` on Windows)

---

## Installation

### Option 1: Install Directly from GitHub

```bash
paseo plugin install git:Myasuka/paseo-antigravity-acp
```

### Option 2: Install from Local Checkout

```bash
git clone https://github.com/Myasuka/paseo-antigravity-acp.git
cd paseo-antigravity-acp
npm install
paseo plugin install "$(pwd)"
```

Or register the directory manually in `~/.paseo/config.json`:

```json
{
  "plugins": {
    "antigravity-approval": "/absolute/path/to/paseo-antigravity-acp"
  }
}
```

> **Note:** The manifest ID is `antigravity-approval` and the registered provider ID is `antigravity-acp` to maintain seamless session compatibility.

---

## Using Native `/swarm` in Paseo

1. Create or open an agent using **Antigravity · ACP** (`antigravity-acp`).
2. Switch the session mode to **Full access** (required so background Swarm workers can run tools without stalling on headless approvals).
3. Send `/swarm <your task>` (or ask AGY to read its `swarm` skill and coordinate parallel workers).
4. Click the **Swarm** pill in the composer bar—or run `/swarm-board`—to open the live **Swarm Board** side panel.

---

## Configuration

Open **Settings -> Antigravity ACP** in Paseo (or run **Configure Antigravity ACP** from the Command Center):

| Setting | Default | Description |
| --- | --- | --- |
| `agyPath` | `""` (auto-detect) | Custom path to the `agy` binary (`~/` supported). |
| `progressUpdates` | `true` | Injects guidance for concise milestone updates on multi-step tasks. |
| `backgroundTimeoutMinutes` | `60` | Maximum duration (1–1440 min) to hold a turn while waiting on background tasks or Swarm workers. |
| `readOnlyRoots` | `[]` | Additional directories auto-approved for `realpath`-verified read/search tools only. |

Settings are stored per host under `~/.paseo/plugin-settings/antigravity-approval/policy.json`.

---

## Development & Verification

```bash
npm run check:sanitize   # Verify zero hardcoded user paths, secrets, or internal identifiers
npm run typecheck        # TypeScript strict check across server, client, and shared modules
npm test                 # Full unit & ACP protocol regression suite
```

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
