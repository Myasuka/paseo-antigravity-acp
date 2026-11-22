import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type ScrollView as NativeScrollView, Text, View } from "react-native";
import { z } from "zod";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  useTabState,
  useTranslation,
  type PluginAgentPanelProps,
  type PluginButtonIconProps,
  type PluginText,
} from "@getpaseo/plugin/client";
import { copyText, Icon, Loading, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import {
  swarmSnapshotRpc,
  type SwarmEdge,
  type SwarmMember,
  type SwarmMessage,
  type SwarmSnapshotReady,
} from "../shared/swarm";
import { messages } from "./messages";

type TabId = "overview" | "board" | "members" | "graph";

const PanelTabStateSchema = z.object({
  activeTab: z.enum(["overview", "board", "members", "graph"]),
  follow: z.boolean(),
  showKilled: z.boolean(),
  expandAll: z.boolean(),
  hideInactive: z.boolean(),
});

type PanelTabState = z.output<typeof PanelTabStateSchema>;

const DEFAULT_PANEL_STATE: PanelTabState = {
  activeTab: "overview",
  follow: true,
  showKilled: false,
  expandAll: false,
  hideInactive: false,
};

const STARTER_PROMPT =
  "/swarm Coordinate parallel workers with a verifier on this task. Share clear ownership boundaries and report the verified summary when complete.";

function formatClock(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function StatusDot({ status, theme, size = 8 }: { status: SwarmMember["status"]; theme: PluginTheme; size?: number }) {
  if (status === "active") {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.statusSuccess,
        }}
      />
    );
  }
  if (status === "waiting") {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: theme.colors.foregroundMuted,
          backgroundColor: "transparent",
        }}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.border,
      }}
    />
  );
}

export type SwarmPillSummary = {
  state: "none" | "idle" | "live" | "alert";
  active: number;
  waiting: number;
  alerts: number;
};

type SwarmPillListener = (summary: SwarmPillSummary) => void;
const pillSummaryListeners = new Map<string, Set<SwarmPillListener>>();

export function subscribeSwarmPillSummary(agentId: string, listener: SwarmPillListener): () => void {
  let listeners = pillSummaryListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    pillSummaryListeners.set(agentId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = pillSummaryListeners.get(agentId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) pillSummaryListeners.delete(agentId);
  };
}

export function publishSwarmPillSummary(agentId: string, summary: SwarmPillSummary) {
  const listeners = pillSummaryListeners.get(agentId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener(summary);
  }
}

export function formatSwarmPillLabel(summary: SwarmPillSummary): PluginText {
  if (summary.state === "alert") {
    return summary.active > 0
      ? messages.message("swarmPillActiveAlertLabel", { active: summary.active, alerts: summary.alerts })
      : messages.message("swarmPillAlertLabel", { alerts: summary.alerts });
  }
  if (summary.state === "live") {
    return summary.active > 0
      ? messages.message("swarmPillActiveLabel", { active: summary.active })
      : messages.message("swarmPillLiveLabel");
  }
  return messages.message("swarmPillLabel");
}

export function SwarmStatusPillIcon(props: PluginButtonIconProps) {
  const fetchSnapshot = useRpc(swarmSnapshotRpc);
  const agentId = props.context === "agent" ? props.agentId : "";
  const [indicator, setIndicator] = useState<"none" | "idle" | "live" | "alert">("none");
  const etagRef = useRef<string | undefined>(undefined);
  const lastSummaryKeyRef = useRef<string>("");

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lastSummaryKeyRef.current = "";

    const poll = async () => {
      let nextDelayMs = 4000;
      try {
        const res = await fetchSnapshot({ agentId, etag: etagRef.current });
        if (cancelled) return;
        let nextSummary: SwarmPillSummary;
        if (res.status === "empty") {
          etagRef.current = undefined;
          nextSummary = { state: "none", active: 0, waiting: 0, alerts: 0 };
        } else {
          etagRef.current = res.etag;
          const nextState: SwarmPillSummary["state"] =
            res.counts.alerts > 0 ? "alert" : res.live ? "live" : "idle";
          nextSummary = {
            state: nextState,
            active: res.counts.active,
            waiting: res.counts.waiting,
            alerts: res.counts.alerts,
          };
          if (nextState === "live" || nextState === "alert") nextDelayMs = 2500;
        }
        setIndicator(nextSummary.state);
        const key = `${nextSummary.state}:${nextSummary.active}:${nextSummary.waiting}:${nextSummary.alerts}`;
        if (key !== lastSummaryKeyRef.current) {
          lastSummaryKeyRef.current = key;
          publishSwarmPillSummary(agentId, nextSummary);
        }
      } catch {
        // Keep last indicator when host is transiently reconnecting.
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void poll();
        }, nextDelayMs);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, fetchSnapshot]);

  if (indicator === "live" || indicator === "alert") {
    const dotColor = indicator === "alert" ? props.theme.colors.statusWarning : props.theme.colors.statusSuccess;
    return (
      <View
        style={{
          width: props.size,
          height: props.size,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: Math.max(8, Math.round(props.size * 0.65)),
            height: Math.max(8, Math.round(props.size * 0.65)),
            borderRadius: props.size,
            backgroundColor: dotColor,
          }}
        />
      </View>
    );
  }

  return <Icon name="Network" size={props.size} color={props.color} />;
}

function OverviewTab({
  snapshot,
  theme,
  onJumpToSeq,
  onOpenBoard,
}: {
  snapshot: SwarmSnapshotReady;
  theme: PluginTheme;
  onJumpToSeq: (seq: number) => void;
  onOpenBoard: () => void;
}) {
  const { t } = useTranslation(messages);
  const memberByName = useMemo(
    () => new Map(snapshot.members.map((m) => [m.name.toLowerCase(), m])),
    [snapshot.members],
  );
  const activeWorkers = useMemo(
    () => snapshot.members.filter((m) => m.status === "active" && !m.isObserver),
    [snapshot.members],
  );
  const recentMessages = useMemo(() => snapshot.messages.slice(-4).reverse(), [snapshot.messages]);

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
      {snapshot.systemAttention.length > 0 ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.statusDanger,
            backgroundColor: theme.colors.surface1,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="AlertTriangle" size={14} color={theme.colors.statusDanger} />
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "700" }}>
              {t("systemAlertsTitle")} ({snapshot.systemAttention.length})
            </Text>
          </View>
          {snapshot.systemAttention.map((alert) => (
            <View key={alert.id} style={{ gap: 2 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{alert.text}</Text>
              {alert.detail ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={3}>
                  {alert.detail}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {snapshot.plan?.goal ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 4,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            {t("goalTitle")}
          </Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
            {snapshot.plan.goal.title}
          </Text>
          {snapshot.plan.goal.line ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{snapshot.plan.goal.line}</Text>
          ) : null}
        </View>
      ) : null}

      {snapshot.view ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            {snapshot.view.phase ? (
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "700" }}>
                Phase {snapshot.view.phase.index}/{snapshot.view.phase.total} · {snapshot.view.phase.label}
              </Text>
            ) : (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
                {t("tabOverview")}
              </Text>
            )}
            {snapshot.view.stale ? (
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{t("staleBadge")}</Text>
              </View>
            ) : null}
          </View>

          {snapshot.view.headline ? (
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", lineHeight: 20 }}>
              {snapshot.view.headline}
            </Text>
          ) : null}

          {snapshot.view.attention.length > 0 ? (
            <View style={{ gap: 6 }}>
              {snapshot.view.attention.map((item) => {
                const badgeColor =
                  item.severity === "high"
                    ? theme.colors.statusDanger
                    : item.severity === "med"
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundMuted;
                return (
                  <View
                    key={item.id}
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      backgroundColor: theme.colors.surface2,
                      gap: 4,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ color: badgeColor, fontSize: 11, fontWeight: "700" }}>
                        [{item.kind.toUpperCase()}]
                      </Text>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
                        {item.title}
                      </Text>
                    </View>
                    {item.why ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                        {item.why}
                      </Text>
                    ) : null}
                    {item.seqRefs.length > 0 ? (
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                        {item.seqRefs.map((seq) => (
                          <Pressable
                            key={seq}
                            onPress={() => onJumpToSeq(seq)}
                            style={{
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 4,
                              backgroundColor: theme.colors.surface1,
                            }}
                          >
                            <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>#{seq}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}

          {snapshot.view.workstreams.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                {t("workstreamsTitle")}
              </Text>
              {snapshot.view.workstreams.map((ws) => (
                <View
                  key={ws.id}
                  style={{
                    padding: 8,
                    borderRadius: 6,
                    backgroundColor: theme.colors.surface2,
                    gap: 3,
                  }}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
                      {ws.title}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{ws.state}</Text>
                  </View>
                  {ws.owners.length > 0 ? (
                    <Text style={{ color: theme.colors.accent, fontSize: 11 }}>
                      {ws.owners.map((o) => `@${o}`).join(" ")}
                    </Text>
                  ) : null}
                  {ws.note ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{ws.note}</Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {snapshot.view.milestones.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                {t("milestonesTitle")}
              </Text>
              {snapshot.view.milestones.map((ms) => (
                <Text key={ms.id} style={{ color: theme.colors.foreground, fontSize: 12 }}>
                  • {ms.text}
                </Text>
              ))}
            </View>
          ) : null}

          {snapshot.view.risks.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
                {t("risksTitle")}
              </Text>
              {snapshot.view.risks.map((rk) => (
                <Text key={rk.id} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                  • {rk.text}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {snapshot.plan && snapshot.plan.threads.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            {t("threadsTitle")}
          </Text>
          {snapshot.plan.threads.map((thread) => (
            <View
              key={thread.id}
              style={{
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                gap: 6,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>{thread.title}</Text>
              {thread.goal ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{thread.goal}</Text>
              ) : null}
              <View style={{ gap: 4, marginTop: 2 }}>
                {thread.tasks.map((memberName) => {
                  const member = memberByName.get(memberName.toLowerCase());
                  const desc = snapshot.plan?.tasks[memberName];
                  return (
                    <View key={memberName} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <StatusDot status={member?.status ?? "waiting"} theme={theme} />
                      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                        @{memberName}
                      </Text>
                      {desc ? (
                        <Text
                          style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}
                          numberOfLines={1}
                        >
                          — {desc}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {activeWorkers.length > 0 ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 8,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            {t("statusActive").toUpperCase()} ({activeWorkers.length})
          </Text>
          {activeWorkers.map((worker) => (
            <View key={worker.name} style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <StatusDot status="active" theme={theme} />
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>@{worker.name}</Text>
                {worker.model ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{worker.model}</Text>
                ) : null}
              </View>
              {worker.activity ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingLeft: 14 }} numberOfLines={1}>
                  {worker.activity}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {recentMessages.length > 0 ? (
        <View
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
              {t("recentActivityTitle")}
            </Text>
            <Pressable onPress={onOpenBoard}>
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{t("viewAllPosts")}</Text>
            </Pressable>
          </View>
          {recentMessages.map((msg) => (
            <Pressable
              key={msg.seq}
              onPress={() => onJumpToSeq(msg.seq)}
              style={{
                padding: 8,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
                gap: 3,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                  #{msg.seq} @{msg.agent}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{formatClock(msg.time)}</Text>
              </View>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
                {msg.text}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function BoardTab({
  snapshot,
  theme,
  follow,
  highlightedSeq,
  onSelectSeq,
}: {
  snapshot: SwarmSnapshotReady;
  theme: PluginTheme;
  follow: boolean;
  highlightedSeq: number | null;
  onSelectSeq: (seq: number) => void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const scrollRef = useRef<NativeScrollView | null>(null);
  const [search, setSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [expandedSeqs, setExpandedSeqs] = useState<Record<number, boolean>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return snapshot.messages.filter((msg) => {
      if (memberFilter) {
        const lower = memberFilter.toLowerCase();
        const involved =
          msg.agent.toLowerCase() === lower || msg.mentions.some((m) => m.toLowerCase() === lower);
        if (!involved) return false;
      }
      if (!q) return true;
      return (
        msg.text.toLowerCase().includes(q) ||
        msg.agent.toLowerCase().includes(q) ||
        msg.channel.toLowerCase().includes(q) ||
        `#${msg.seq}` === q
      );
    });
  }, [memberFilter, search, snapshot.messages]);

  useEffect(() => {
    if (!follow || search.trim() || memberFilter) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 60);
    return () => clearTimeout(timer);
  }, [follow, memberFilter, search, snapshot.headSeq]);

  const handleCopy = useCallback(
    async (msg: SwarmMessage) => {
      await copyText(`#${msg.seq} @${msg.agent}: ${msg.text}`);
      toast.show(t("copiedToast"), { variant: "success" });
    },
    [t, toast],
  );

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          gap: 8,
        }}
      >
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t("searchPlaceholder")}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            fontSize: 13,
          }}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          <Pressable
            onPress={() => setMemberFilter(null)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: memberFilter === null ? theme.colors.accent : theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: memberFilter === null ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {t("allMembersFilter")}
            </Text>
          </Pressable>
          {snapshot.members
            .filter((m) => !m.isObserver)
            .map((m) => {
              const selected = memberFilter === m.name;
              return (
                <Pressable
                  key={m.name}
                  onPress={() => setMemberFilter(selected ? null : m.name)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 999,
                    backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
                  }}
                >
                  <StatusDot status={m.status} theme={theme} size={6} />
                  <Text
                    style={{
                      color: selected ? theme.colors.accentForeground : theme.colors.foreground,
                      fontSize: 11,
                      fontWeight: "600",
                    }}
                  >
                    @{m.name}
                  </Text>
                </Pressable>
              );
            })}
        </ScrollView>
      </View>

      {filtered.length === 0 ? (
        <View style={{ padding: 24, alignItems: "center", gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{t("noMessagesMatch")}</Text>
          {search || memberFilter ? (
            <Pressable
              onPress={() => {
                setSearch("");
                setMemberFilter(null);
              }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {t("clearFilters")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 12, gap: 8 }}>
          {filtered.map((msg) => {
            const isHighlighted = highlightedSeq === msg.seq;
            const isLong = msg.text.length > 520;
            const isExpanded = Boolean(expandedSeqs[msg.seq]);
            const displayText = isLong && !isExpanded ? `${msg.text.slice(0, 520)}…` : msg.text;
            const recipients = [
              ...(msg.all ? ["@all"] : []),
              ...msg.channelMentions.map((ch) => `@#${ch}`),
              ...msg.mentions.map((m) => `@${m}`),
            ];

            return (
              <View
                key={msg.seq}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: isHighlighted
                    ? theme.colors.accent
                    : msg.mentionsViewer
                      ? theme.colors.accent
                      : theme.colors.border,
                  borderLeftWidth: msg.mentionsViewer || isHighlighted ? 3 : 1,
                  backgroundColor: isHighlighted ? theme.colors.surface2 : theme.colors.surface1,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 1 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>
                      @{msg.agent}
                    </Text>
                    {msg.channel !== "main" ? (
                      <View
                        style={{
                          paddingHorizontal: 5,
                          paddingVertical: 1,
                          borderRadius: 4,
                          backgroundColor: theme.colors.surface2,
                        }}
                      >
                        <Text style={{ color: theme.colors.accent, fontSize: 11 }}>#{msg.channel}</Text>
                      </View>
                    ) : null}
                    {recipients.length > 0 ? (
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                        → {recipients.join(" ")}
                      </Text>
                    ) : null}
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                      #{msg.seq} · {formatClock(msg.time)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void handleCopy(msg);
                      }}
                    >
                      <Icon name="Copy" size={13} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  </View>
                </View>

                <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>{displayText}</Text>

                {isLong ? (
                  <Pressable
                    onPress={() => setExpandedSeqs((prev) => ({ ...prev, [msg.seq]: !isExpanded }))}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                      {isExpanded ? t("showLess") : t("showMore")}
                    </Text>
                  </Pressable>
                ) : null}

                {msg.seqRefs.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {msg.seqRefs.map((refSeq) => (
                      <Pressable
                        key={refSeq}
                        onPress={() => {
                          setSearch("");
                          setMemberFilter(null);
                          onSelectSeq(refSeq);
                        }}
                        style={{
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: 4,
                          backgroundColor: theme.colors.surface2,
                        }}
                      >
                        <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                          ↪ #{refSeq}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function MembersTab({
  snapshot,
  theme,
  showKilled,
  onToggleKilled,
}: {
  snapshot: SwarmSnapshotReady;
  theme: PluginTheme;
  showKilled: boolean;
  onToggleKilled: () => void;
}) {
  const { t } = useTranslation(messages);
  const killedTotal = useMemo(
    () => snapshot.members.filter((m) => m.status === "killed").length,
    [snapshot.members],
  );
  const visibleMembers = useMemo(
    () => (showKilled ? snapshot.members : snapshot.members.filter((m) => m.status !== "killed")),
    [showKilled, snapshot.members],
  );

  const statusLabel = (status: SwarmMember["status"]) => {
    if (status === "active") return t("statusActive");
    if (status === "killed") return t("statusKilled");
    return t("statusWaiting");
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 10 }}>
      {killedTotal > 0 ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Pressable
            onPress={onToggleKilled}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {showKilled ? t("hideKilled") : `${t("showKilled")} (${killedTotal})`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {visibleMembers.map((member) => (
        <View
          key={member.name}
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: member.isSelf ? theme.colors.accent : theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 6,
            opacity: member.status === "killed" ? 0.65 : 1,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 1 }}>
              <StatusDot status={member.status} theme={theme} size={9} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  fontWeight: "700",
                  textDecorationLine: member.status === "killed" ? "line-through" : "none",
                }}
              >
                @{member.name}
              </Text>
              {member.isSelf ? (
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                    borderRadius: 4,
                    backgroundColor: theme.colors.accent,
                  }}
                >
                  <Text style={{ color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" }}>
                    {t("youBadge")}
                  </Text>
                </View>
              ) : null}
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 4,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{member.role}</Text>
              </View>
            </View>
            {member.model ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                {member.model}
              </Text>
            ) : null}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {statusLabel(member.status)}
              {member.wakeMode ? ` (${member.wakeMode === "any" ? "any post" : "@mentions"})` : ""}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>steps: {member.steps}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>posts: {member.posts}</Text>
            {member.unread > 0 ? (
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                unread: {member.unread}
              </Text>
            ) : null}
          </View>

          {member.channels.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              {member.channels.map((ch) => (
                <Text key={ch} style={{ color: theme.colors.accent, fontSize: 11 }}>
                  #{ch}
                </Text>
              ))}
            </View>
          ) : null}

          {member.activity ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                padding: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon
                name={member.activityKind === "thinking" ? "Brain" : "Terminal"}
                size={12}
                color={theme.colors.statusSuccess}
              />
              <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                {member.activity}
              </Text>
            </View>
          ) : null}

          {member.failure ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }} numberOfLines={2}>
              [{member.failure.kind}] {member.failure.message}
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

function GraphTab({
  snapshot,
  theme,
  expandAll,
  hideInactive,
  onToggleExpandAll,
  onToggleHideInactive,
  onJumpToSeq,
}: {
  snapshot: SwarmSnapshotReady;
  theme: PluginTheme;
  expandAll: boolean;
  hideInactive: boolean;
  onToggleExpandAll: () => void;
  onToggleHideInactive: () => void;
  onJumpToSeq: (seq: number) => void;
}) {
  const { t } = useTranslation(messages);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const totalMessages = snapshot.messages.length;
  const activeMsg: SwarmMessage | null =
    replayIndex !== null && snapshot.messages[replayIndex]
      ? snapshot.messages[replayIndex]
      : snapshot.messages.at(-1) ?? null;

  useEffect(() => {
    if (!playing || totalMessages === 0) return;
    const timer = setInterval(() => {
      setReplayIndex((prev) => {
        const curr = prev ?? 0;
        if (curr + 1 >= totalMessages) {
          setPlaying(false);
          return null;
        }
        return curr + 1;
      });
    }, 1200);
    return () => clearInterval(timer);
  }, [playing, totalMessages]);

  const allBroadcastCountBySender = useMemo(() => {
    const counts = new Map<string, number>();
    const uptoSeq = activeMsg?.seq ?? snapshot.headSeq;
    for (const msg of snapshot.messages) {
      if (msg.seq > uptoSeq) break;
      if (msg.all) counts.set(msg.agent, (counts.get(msg.agent) ?? 0) + 1);
    }
    return counts;
  }, [activeMsg, snapshot.headSeq, snapshot.messages]);

  const visibleEdges = useMemo(() => {
    if (replayIndex === null) {
      return snapshot.edges
        .map((edge) => ({
          ...edge,
          effectiveCount: expandAll ? edge.count : edge.direct + edge.viaChannel,
        }))
        .filter((edge) => edge.effectiveCount > 0);
    }
    // Recompute edges up through the current replay step for faithful historical stepping.
    const uptoSeq = activeMsg?.seq ?? 0;
    const graphMembers = snapshot.members.filter((m) => !m.isObserver);
    const byName = new Map(snapshot.members.map((m) => [m.name.toLowerCase(), m]));
    const acc = new Map<string, SwarmEdge & { effectiveCount: number }>();

    const record = (from: string, to: string, kind: "direct" | "channel" | "all", seq: number) => {
      if (from.toLowerCase() === to.toLowerCase()) return;
      const key = `${from}->${to}`;
      const cur = acc.get(key) ?? {
        from,
        to,
        count: 0,
        direct: 0,
        viaChannel: 0,
        viaAll: 0,
        lastSeq: seq,
        effectiveCount: 0,
      };
      cur.count += 1;
      if (kind === "direct") cur.direct += 1;
      else if (kind === "channel") cur.viaChannel += 1;
      else cur.viaAll += 1;
      cur.lastSeq = Math.max(cur.lastSeq, seq);
      cur.effectiveCount = expandAll ? cur.count : cur.direct + cur.viaChannel;
      acc.set(key, cur);
    };

    for (const msg of snapshot.messages) {
      if (msg.seq > uptoSeq) break;
      const sender = byName.get(msg.agent.toLowerCase());
      if (sender?.isObserver) continue;
      const credited = new Set<string>();
      for (const targetName of msg.mentions) {
        const target = byName.get(targetName.toLowerCase());
        if (!target || target.isObserver || target.name === msg.agent) continue;
        credited.add(target.name);
        record(msg.agent, target.name, "direct", msg.seq);
      }
      if (msg.channelMentions.length > 0) {
        for (const target of graphMembers) {
          if (target.name === msg.agent || credited.has(target.name)) continue;
          const inCh =
            target.name === "coordinator" ||
            target.channels.some((ch) => msg.channelMentions.includes(ch.toLowerCase()));
          if (inCh) {
            credited.add(target.name);
            record(msg.agent, target.name, "channel", msg.seq);
          }
        }
      }
      if (msg.all) {
        for (const target of graphMembers) {
          if (target.name === msg.agent || credited.has(target.name)) continue;
          credited.add(target.name);
          record(msg.agent, target.name, "all", msg.seq);
        }
      }
    }

    return [...acc.values()]
      .filter((e) => e.effectiveCount > 0)
      .sort((a, b) => b.effectiveCount - a.effectiveCount || b.lastSeq - a.lastSeq);
  }, [activeMsg, expandAll, replayIndex, snapshot.edges, snapshot.members, snapshot.messages]);

  const maxWeight = useMemo(
    () => visibleEdges.reduce((max, e) => Math.max(max, e.effectiveCount), 1),
    [visibleEdges],
  );

  const visibleNodes = useMemo(() => {
    const base = snapshot.members.filter((m) => !m.isObserver);
    if (!hideInactive) return base;
    return base.filter((m) => {
      if (activeMsg && (activeMsg.agent === m.name || activeMsg.mentions.includes(m.name))) return true;
      if (m.status === "killed") return false;
      return m.posts > 0 || visibleEdges.some((e) => e.from === m.name || e.to === m.name);
    });
  }, [activeMsg, hideInactive, snapshot.members, visibleEdges]);

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 14 }}>
      <View
        style={{
          padding: 12,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>
            {t("replayTitle")}{" "}
            {totalMessages > 0
              ? `(${replayIndex !== null ? replayIndex + 1 : totalMessages}/${totalMessages})`
              : ""}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable
              disabled={totalMessages === 0}
              onPress={() => {
                setPlaying(false);
                setReplayIndex((prev) => {
                  const curr = prev ?? totalMessages - 1;
                  return Math.max(0, curr - 1);
                });
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{t("replayPrev")}</Text>
            </Pressable>
            <Pressable
              disabled={totalMessages === 0}
              onPress={() => {
                if (playing) {
                  setPlaying(false);
                } else {
                  if (replayIndex === null || replayIndex >= totalMessages - 1) setReplayIndex(0);
                  setPlaying(true);
                }
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>
                {playing ? t("replayPause") : t("replayPlay")}
              </Text>
            </Pressable>
            <Pressable
              disabled={totalMessages === 0 || replayIndex === null}
              onPress={() => {
                setPlaying(false);
                setReplayIndex((prev) => {
                  if (prev === null) return null;
                  return prev + 1 >= totalMessages ? null : prev + 1;
                });
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
                opacity: replayIndex === null ? 0.5 : 1,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{t("replayNext")}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setPlaying(false);
                setReplayIndex(null);
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: replayIndex === null ? theme.colors.accent : theme.colors.surface2,
              }}
            >
              <Text
                style={{
                  color: replayIndex === null ? theme.colors.accentForeground : theme.colors.foreground,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {t("replayLive")}
              </Text>
            </Pressable>
          </View>
        </View>

        {activeMsg ? (
          <Pressable
            onPress={() => onJumpToSeq(activeMsg.seq)}
            style={{
              padding: 8,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
              gap: 3,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "700" }}>
                #{activeMsg.seq} @{activeMsg.agent}
                {activeMsg.all
                  ? " → @all"
                  : activeMsg.mentions.length > 0
                    ? ` → ${activeMsg.mentions.map((m) => `@${m}`).join(" ")}`
                    : ""}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{formatClock(activeMsg.time)}</Text>
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={2}>
              {activeMsg.text}
            </Text>
          </Pressable>
        ) : null}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Pressable
            onPress={onToggleExpandAll}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: expandAll ? theme.colors.accent : theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: expandAll ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {t("expandAllToggle")}
            </Text>
          </Pressable>
          <Pressable
            onPress={onToggleHideInactive}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: hideInactive ? theme.colors.accent : theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: hideInactive ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {t("hideInactiveToggle")}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {visibleNodes.map((node) => {
          const isCurrentSender = activeMsg?.agent === node.name;
          const isCurrentRecipient =
            Boolean(activeMsg?.mentions.includes(node.name)) || (expandAll && Boolean(activeMsg?.all) && !isCurrentSender);
          const allCount = allBroadcastCountBySender.get(node.name) ?? 0;

          return (
            <View
              key={node.name}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor:
                  isCurrentSender || isCurrentRecipient ? theme.colors.accent : theme.colors.border,
                backgroundColor: isCurrentSender ? theme.colors.surface2 : theme.colors.surface1,
              }}
            >
              <StatusDot status={node.status} theme={theme} size={7} />
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>@{node.name}</Text>
              {!expandAll && allCount > 0 ? (
                <View
                  style={{
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                    borderRadius: 999,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>@all {allCount}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
          {t("edgesTitle")} ({visibleEdges.length})
        </Text>
        {visibleEdges.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{t("noEdgesYet")}</Text>
        ) : (
          visibleEdges.map((edge) => {
            const isCurrentEdge =
              activeMsg?.agent === edge.from &&
              (activeMsg.mentions.includes(edge.to) || (expandAll && activeMsg.all));
            const ratio = Math.max(0.08, edge.effectiveCount / maxWeight);
            return (
              <Pressable
                key={`${edge.from}->${edge.to}`}
                onPress={() => onJumpToSeq(edge.lastSeq)}
                style={{
                  padding: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: isCurrentEdge ? theme.colors.accent : theme.colors.border,
                  backgroundColor: isCurrentEdge ? theme.colors.surface2 : theme.colors.surface1,
                  gap: 6,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                    @{edge.from} → @{edge.to}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {edge.effectiveCount}× · #{edge.lastSeq}
                  </Text>
                </View>
                <View
                  style={{
                    height: 5,
                    borderRadius: 999,
                    backgroundColor: theme.colors.surface2,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      width: `${Math.round(ratio * 100)}%`,
                      height: "100%",
                      borderRadius: 999,
                      backgroundColor: isCurrentEdge ? theme.colors.accent : theme.colors.foregroundMuted,
                    }}
                  />
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

export function SwarmBoardPanel({ params, theme, tab }: PluginAgentPanelProps) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const fetchSnapshot = useRpc(swarmSnapshotRpc);
  const [panelState, setPanelState] = useTabState(tab, PanelTabStateSchema, DEFAULT_PANEL_STATE);
  const [loading, setLoading] = useState(true);
  const [readySnapshot, setReadySnapshot] = useState<SwarmSnapshotReady | null>(null);
  const [emptyMeta, setEmptyMeta] = useState<{ modeId: string | null; provider: string | null }>({
    modeId: null,
    provider: null,
  });
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);
  const etagRef = useRef<string | undefined>(undefined);

  const loadSnapshot = useCallback(
    async (forceFull = false) => {
      try {
        const res = await fetchSnapshot({
          agentId: params.agentId,
          etag: forceFull ? undefined : etagRef.current,
        });
        if (res.status === "empty") {
          etagRef.current = undefined;
          setReadySnapshot(null);
          setEmptyMeta({ modeId: res.modeId, provider: res.provider });
        } else if (res.status === "ready") {
          etagRef.current = res.etag;
          setReadySnapshot(res);
        } else if (res.status === "unchanged") {
          etagRef.current = res.etag;
          setReadySnapshot((prev) =>
            prev ? { ...prev, live: res.live, counts: res.counts } : prev,
          );
        }
      } catch {
        // Keep last good snapshot on transient daemon reconnect.
      } finally {
        setLoading(false);
      }
    },
    [fetchSnapshot, params.agentId],
  );

  useEffect(() => {
    etagRef.current = undefined;
    setLoading(true);
    void loadSnapshot(true);
    const timer = setInterval(() => {
      void loadSnapshot(false);
    }, 1500);
    return () => clearInterval(timer);
  }, [loadSnapshot]);

  const setActiveTab = useCallback(
    (activeTab: TabId) => {
      setPanelState({ ...panelState, activeTab });
    },
    [panelState, setPanelState],
  );

  const jumpToSeq = useCallback(
    (seq: number) => {
      setHighlightedSeq(seq);
      setPanelState({ ...panelState, activeTab: "board", follow: false });
    },
    [panelState, setPanelState],
  );

  const handleCopyStarter = useCallback(async () => {
    await copyText(STARTER_PROMPT);
    toast.show(t("copiedToast"), { variant: "success" });
  }, [t, toast]);

  if (loading && !readySnapshot) {
    return <Loading />;
  }

  if (!readySnapshot) {
    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
        <View
          style={{
            padding: 16,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Network" size={18} color={theme.colors.accent} />
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
              {t("emptySwarmTitle")}
            </Text>
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
            {t("emptySwarmBody")}
          </Text>
          {emptyMeta.provider === "antigravity-acp" && emptyMeta.modeId !== "full-access" ? (
            <View
              style={{
                padding: 10,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12, lineHeight: 17 }}>
                {t("fullAccessHint")}
              </Text>
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void handleCopyStarter();
              }}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" }}>
                {t("copyStarterPrompt")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void loadSnapshot(true);
              }}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {t("refreshButton")}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    );
  }

  const tabs: Array<{ id: TabId; label: string; badge?: number }> = [
    { id: "overview", label: t("tabOverview"), badge: readySnapshot.counts.alerts || undefined },
    { id: "board", label: t("tabBoard"), badge: readySnapshot.counts.messages },
    {
      id: "members",
      label: t("tabMembers"),
      badge: readySnapshot.members.filter((m) => m.status !== "killed").length,
    },
    { id: "graph", label: t("tabGraph"), badge: readySnapshot.edges.length || undefined },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 6,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
              {readySnapshot.title}
            </Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <StatusDot status={readySnapshot.live ? "active" : "waiting"} theme={theme} size={6} />
              <Text
                style={{
                  color: readySnapshot.live ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
                  fontSize: 10,
                  fontWeight: "700",
                }}
              >
                {readySnapshot.live ? t("liveBadge") : t("idleBadge")}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {panelState.activeTab === "board" ? (
              <Pressable
                onPress={() => setPanelState({ ...panelState, follow: !panelState.follow })}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: panelState.follow ? theme.colors.accent : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: panelState.follow ? theme.colors.accentForeground : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {t("followToggle")}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void loadSnapshot(true);
              }}
              style={{ padding: 4 }}
            >
              <Icon name="RefreshCw" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
        </View>

        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {readySnapshot.counts.active} {t("statusActive")} · {readySnapshot.counts.waiting} {t("statusWaiting")}
          {readySnapshot.counts.killed > 0 ? ` · ${readySnapshot.counts.killed} ${t("statusKilled")}` : ""}
          {readySnapshot.viewerMember ? ` · @${readySnapshot.viewerMember}` : ""}
        </Text>

        <View style={{ flexDirection: "row", gap: 4, marginTop: 2 }}>
          {tabs.map((item) => {
            const active = panelState.activeTab === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setActiveTab(item.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderBottomWidth: 2,
                  borderBottomColor: active ? theme.colors.accent : "transparent",
                }}
              >
                <Text
                  style={{
                    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: 12,
                    fontWeight: active ? "700" : "500",
                  }}
                >
                  {item.label}
                </Text>
                {item.badge !== undefined ? (
                  <Text
                    style={{
                      color:
                        item.id === "overview" && item.badge > 0
                          ? theme.colors.statusWarning
                          : theme.colors.foregroundMuted,
                      fontSize: 11,
                      fontWeight: "600",
                    }}
                  >
                    {item.badge}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>

      {panelState.activeTab === "overview" ? (
        <OverviewTab
          snapshot={readySnapshot}
          theme={theme}
          onJumpToSeq={jumpToSeq}
          onOpenBoard={() => setActiveTab("board")}
        />
      ) : null}
      {panelState.activeTab === "board" ? (
        <BoardTab
          snapshot={readySnapshot}
          theme={theme}
          follow={panelState.follow}
          highlightedSeq={highlightedSeq}
          onSelectSeq={jumpToSeq}
        />
      ) : null}
      {panelState.activeTab === "members" ? (
        <MembersTab
          snapshot={readySnapshot}
          theme={theme}
          showKilled={panelState.showKilled}
          onToggleKilled={() => setPanelState({ ...panelState, showKilled: !panelState.showKilled })}
        />
      ) : null}
      {panelState.activeTab === "graph" ? (
        <GraphTab
          snapshot={readySnapshot}
          theme={theme}
          expandAll={panelState.expandAll}
          hideInactive={panelState.hideInactive}
          onToggleExpandAll={() => setPanelState({ ...panelState, expandAll: !panelState.expandAll })}
          onToggleHideInactive={() => setPanelState({ ...panelState, hideInactive: !panelState.hideInactive })}
          onJumpToSeq={jumpToSeq}
        />
      ) : null}
    </View>
  );
}
