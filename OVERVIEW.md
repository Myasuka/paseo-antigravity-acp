# Antigravity ACP for Paseo

Bring Google Antigravity (`agy acp`) into Paseo as a first-class provider with interactive permission approvals, native **Full access** restarts, per-model thinking levels, autonomous background & `/swarm` turn continuation, and a built-in **Swarm Board** visualizer.

## Highlights

- **Interactive Approvals + Safe Skill Reads**: Prompts in Paseo before executing shell commands, edits, writes, web fetches, or MCP tools while automatically allowing canonical `realpath`-checked reads inside standard skill directories (`~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`, `~/.gemini/antigravity-cli/builtin/skills`, plus any custom directories configured in plugin settings).
- **Explicit Full Access Mode**: Enters and exits Antigravity's native `--dangerously-skip-permissions` mode via a clean idle session reopen so autonomous background subagents and Swarm workers never silently stall or leak elevated permissions back to default mode.
- **Per-Model Thinking Levels**: Probes each Antigravity model's supported `thought_level` options (`low`, `medium`, `high`, `xhigh`, or none) during catalog discovery.
- **Background & Native `/swarm` Continuation**: Keeps Paseo turns alive across asynchronous `run_command` tasks, `invoke_subagent` calls, and native Antigravity `/swarm` task workers—streaming post-foreground replies, tool cards, and token usage while ignoring observer-only roles (`narrator`, `monitor`) once work settles.
- **Built-in Swarm Board Panel**: Inspect live Antigravity Swarms directly inside Paseo (`Overview`, `Board`, `Members`, and `@mention` `Graph` with step-by-step replay) via the agent panel, composer pill, Command Center, or `/swarm-board`—compatible with both `antigravity-acp` and Paseo's built-in `antigravity` sessions.
