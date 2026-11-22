import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { messages } from "./client/messages";
import { AntigravitySettingsScreen } from "./client/settings-screen";
import {
  SwarmBoardPanel,
  SwarmStatusPillIcon,
  formatSwarmPillLabel,
  subscribeSwarmPillSummary,
} from "./client/swarm-panel";

function isAntigravityProvider(provider?: string | null): boolean {
  return provider === "antigravity-acp" || provider === "antigravity";
}

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "policy",
    title: messages.message("settingsTitle"),
    icon: "SlidersHorizontal",
    Component: AntigravitySettingsScreen,
  });

  const removeSwarmPanel = client.addAgentPanel({
    id: "swarm",
    title: messages.message("swarmPanelTitle"),
    icon: "Network",
    locations: ["workspace", "explorer"],
    Component: SwarmBoardPanel,
  });

  const removeSettingsCommand = client.addCommandCenterItem({
    id: "configure-antigravity-acp",
    title: messages.message("openSettingsCommand"),
    icon: "Settings",
    context: "global",
    keywords: ["antigravity", "agy", "acp", "policy"],
    onSelect({ openSettings }) {
      openSettings("policy");
    },
  });

  const removeSwarmCommand = client.addCommandCenterItem({
    id: "open-antigravity-swarm",
    title: messages.message("openSwarmCommand"),
    icon: "Network",
    context: "agent",
    keywords: ["swarm", "board", "antigravity", "agy"],
    onSelect({ openPanel }) {
      openPanel("swarm");
    },
  });

  const removeSlashCommand = client.addSlashCommand({
    name: "swarm-board",
    description: messages.message("openSwarmSlashDesc"),
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("swarm");
    },
  });

  const pills = new Map<
    string,
    { workspaceId: string; reg: PluginButtonRegistration<PluginText>; unsubSummary: () => void }
  >();
  let disposed = false;
  let unsubOwned: (() => void) | undefined;
  let releaseListSub: (() => Promise<void>) | undefined;

  const removePill = (agentId: string) => {
    const existing = pills.get(agentId);
    if (existing) {
      existing.unsubSummary();
      existing.reg.remove();
      pills.delete(agentId);
    }
  };

  const syncAgentPill = (agent: {
    id: string;
    provider?: string | null;
    workspaceId?: string | null;
    archivedAt?: string | null;
  }) => {
    if (disposed) return;
    if (!isAntigravityProvider(agent.provider) || !agent.workspaceId || agent.archivedAt) {
      removePill(agent.id);
      return;
    }
    const workspaceId = agent.workspaceId;
    const existing = pills.get(agent.id);
    if (existing && existing.workspaceId === workspaceId) return;
    existing?.unsubSummary();
    existing?.reg.remove();

    const reg = client.addComposerPill({
      id: "swarm-board",
      workspaceId,
      agentId: agent.id,
      button: {
        title: messages.message("openSwarmCommand"),
        icon: SwarmStatusPillIcon,
        label: messages.message("swarmPillLabel"),
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("swarm", { workspaceId, agentId: agent.id });
          },
        },
      },
    });
    const unsubSummary = subscribeSwarmPillSummary(agent.id, (summary) => {
      reg.update({ label: formatSwarmPillLabel(summary) });
    });
    pills.set(agent.id, { workspaceId, reg, unsubSummary });
  };

  const unsubAgentUpdates = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") {
      syncAgentPill(update.agent);
    } else if ("agentId" in update && typeof update.agentId === "string") {
      removePill(update.agentId);
    }
  });

  void client.paseo.agents
    .list({ subscribe: {} })
    .then((result) => {
      if (disposed) {
        void result.subscription.release();
        return;
      }
      releaseListSub = () => result.subscription.release();
      for (const entry of result.entries) {
        syncAgentPill(entry.agent);
      }
      unsubOwned = result.subscription.subscribe({
        snapshot(snap) {
          for (const entry of snap.entries) {
            syncAgentPill(entry.agent);
          }
        },
        update() {},
      });
    })
    .catch(() => {
      // Host may still be initializing; live agent_update subscription handles subsequent arrivals.
    });

  return () => {
    disposed = true;
    unsubOwned?.();
    void releaseListSub?.();
    unsubAgentUpdates();
    for (const { reg, unsubSummary } of pills.values()) {
      unsubSummary();
      reg.remove();
    }
    pills.clear();
    removeSlashCommand();
    removeSwarmCommand();
    removeSettingsCommand();
    removeSwarmPanel();
    removeSettings();
  };
}
