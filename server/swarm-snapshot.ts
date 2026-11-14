import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  SwarmEdge,
  SwarmMember,
  SwarmMessage,
  SwarmPlan,
  SwarmSnapshotOutput,
  SwarmSnapshotReady,
  SwarmSystemAttention,
  SwarmView,
} from '../shared/swarm.ts';
import {
  UUID_RE,
  extractMentions,
  extractSeqRefs,
  isObserverMember,
  postWakesMember,
  readBoardMessages,
  readBoundedJson,
  resolveEffectiveMemberStatus,
  summarizeMemberTranscript,
  type RawSwarmMember,
} from './swarm-state.mjs';

const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const WORKER_SCAN_TTL_MS = 3000;
const WORKER_NEGATIVE_TTL_MS = 500;

const ATTENTION_KIND_RANK: Readonly<Record<string, number>> = {
  blocker: 0,
  decision: 1,
  failure: 2,
  review: 3,
  stuck: 4,
  quota: 5,
  error: 6,
  warning: 7,
  fyi: 8,
};

const SEVERITY_RANK: Readonly<Record<'high' | 'med' | 'low', number>> = {
  high: 0,
  med: 1,
  low: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampString(value: unknown, maxLen = 280): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function parseUuidFromRawString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith('plugin:')) {
    try {
      const parsed = JSON.parse(trimmed.slice('plugin:'.length)) as unknown;
      if (isRecord(parsed) && isRecord(parsed.data) && typeof parsed.data.sessionId === 'string') {
        const inner = parsed.data.sessionId.trim();
        if (UUID_RE.test(inner)) return inner.toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}

export interface AgentSnapshotLike {
  provider?: string | null;
  currentModeId?: string | null;
  runtimeInfo?: {
    provider?: string | null;
    sessionId?: string | null;
    modeId?: string | null;
  } | null;
  persistence?: {
    provider?: string | null;
    sessionId?: string | null;
    nativeHandle?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
}

export interface PaseoAgentsLookup {
  agents?: {
    ref(agentId: string): {
      current(): AgentSnapshotLike | null | undefined;
      refresh(): Promise<{ agent?: AgentSnapshotLike | null } | null | undefined>;
    };
  };
}

export function extractNativeConversationId(agent?: AgentSnapshotLike | null): string | null {
  if (!agent) return null;
  const candidates: unknown[] = [
    agent.runtimeInfo?.sessionId,
    agent.persistence?.sessionId,
    agent.persistence?.nativeHandle,
  ];
  for (const candidate of candidates) {
    const id = parseUuidFromRawString(candidate);
    if (id) return id;
  }
  const meta = agent.persistence?.metadata;
  if (isRecord(meta)) {
    const direct = parseUuidFromRawString(meta.sessionId);
    if (direct) return direct;
    if (isRecord(meta.pluginProviderPersistence) && isRecord(meta.pluginProviderPersistence.data)) {
      const nested = parseUuidFromRawString(meta.pluginProviderPersistence.data.sessionId);
      if (nested) return nested;
    }
  }
  return null;
}

export function resolveDefaultAgyDataDirs(explicitDataDir?: string): string[] {
  if (explicitDataDir) return [resolve(explicitDataDir)];
  const dirs: string[] = [];
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    dirs.push(resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR));
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configRel = process.env.ANTIGRAVITY_CONFIG_REL_DIR || 'antigravity-cli';
  const standard = resolve(join(home, '.gemini', configRel));
  if (!dirs.includes(standard)) dirs.push(standard);
  return dirs;
}

async function fileStatKey(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch {
    return '0:0';
  }
}

function sanitizePlan(raw: unknown): SwarmPlan | null {
  if (!isRecord(raw)) return null;
  const goal =
    isRecord(raw.goal) && (typeof raw.goal.title === 'string' || typeof raw.goal.line === 'string')
      ? {
          title: clampString(raw.goal.title, 140),
          line: clampString(raw.goal.line, 240),
        }
      : null;

  const tasks: Record<string, string> = {};
  if (isRecord(raw.tasks)) {
    for (const [member, desc] of Object.entries(raw.tasks).slice(0, 64)) {
      const cleaned = clampString(desc, 200);
      if (member && cleaned) tasks[member] = cleaned;
    }
  }

  const threads: SwarmPlan['threads'] = [];
  if (Array.isArray(raw.threads)) {
    for (const item of raw.threads.slice(0, 12)) {
      if (!isRecord(item)) continue;
      const title = clampString(item.title, 140);
      if (!title) continue;
      const threadTasks = Array.isArray(item.tasks)
        ? item.tasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 32)
        : [];
      threads.push({
        id: clampString(item.id, 64) || `thread-${threads.length + 1}`,
        title,
        goal: clampString(item.goal, 240),
        tasks: threadTasks,
      });
    }
  }

  if (!goal && Object.keys(tasks).length === 0 && threads.length === 0) return null;
  return { goal, tasks, threads };
}

function sanitizeView(
  raw: unknown,
  headSeq: number,
  narratorLastReadSeq: number,
  narratorWorking: boolean,
): SwarmView | null {
  if (!isRecord(raw)) return null;
  const headline = clampString(raw.headline, 240) || null;
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : null;
  const asOfSeq = typeof raw.as_of_seq === 'number' && Number.isInteger(raw.as_of_seq) ? raw.as_of_seq : null;

  const phase =
    isRecord(raw.phase) && typeof raw.phase.label === 'string'
      ? {
          label: clampString(raw.phase.label, 80),
          index: typeof raw.phase.index === 'number' ? Math.max(0, Math.trunc(raw.phase.index)) : 1,
          total: typeof raw.phase.total === 'number' ? Math.max(1, Math.trunc(raw.phase.total)) : 1,
        }
      : null;

  const extractRefs = (refs: unknown) => {
    const seqRefs: number[] = [];
    const memberRefs: string[] = [];
    if (Array.isArray(refs)) {
      for (const ref of refs.slice(0, 16)) {
        if (!isRecord(ref)) continue;
        if (typeof ref.seq === 'number' && Number.isInteger(ref.seq) && ref.seq > 0 && ref.seq <= headSeq) {
          seqRefs.push(ref.seq);
        }
        if (typeof ref.member === 'string' && ref.member.trim()) {
          memberRefs.push(ref.member.trim().slice(0, 48));
        }
      }
    }
    return { seqRefs, memberRefs };
  };

  const attention: SwarmView['attention'] = [];
  if (Array.isArray(raw.attention)) {
    for (const item of raw.attention.slice(0, 20)) {
      if (!isRecord(item)) continue;
      const title = clampString(item.title, 180);
      if (!title) continue;
      const kind = clampString(item.kind, 32).toLowerCase() || 'fyi';
      const rawSev = clampString(item.severity, 16).toLowerCase();
      const severity: 'high' | 'med' | 'low' = rawSev === 'high' || rawSev === 'med' ? rawSev : 'low';
      const { seqRefs, memberRefs } = extractRefs(item.refs);
      attention.push({
        id: clampString(item.id, 64) || `attn-${attention.length + 1}`,
        kind,
        severity,
        title,
        why: clampString(item.why, 300),
        seqRefs,
        memberRefs,
      });
    }
    attention.sort((a, b) => {
      const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return (ATTENTION_KIND_RANK[a.kind] ?? 50) - (ATTENTION_KIND_RANK[b.kind] ?? 50);
    });
  }

  const workstreams: SwarmView['workstreams'] = [];
  if (Array.isArray(raw.workstreams)) {
    for (const item of raw.workstreams.slice(0, 24)) {
      if (!isRecord(item)) continue;
      const title = clampString(item.title, 160);
      if (!title) continue;
      const owners = Array.isArray(item.owners)
        ? item.owners.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 12)
        : [];
      workstreams.push({
        id: clampString(item.id, 64) || `ws-${workstreams.length + 1}`,
        title,
        state: clampString(item.state, 24).toLowerCase() || 'active',
        owners,
        note: clampString(item.note, 260),
      });
    }
  }

  const milestones: SwarmView['milestones'] = [];
  if (Array.isArray(raw.milestones)) {
    for (const item of raw.milestones.slice(0, 20)) {
      if (!isRecord(item)) continue;
      const text = clampString(item.text, 220);
      if (text) milestones.push({ id: clampString(item.id, 64) || `ms-${milestones.length + 1}`, text });
    }
  }

  const risks: SwarmView['risks'] = [];
  if (Array.isArray(raw.risks)) {
    for (const item of raw.risks.slice(0, 20)) {
      if (!isRecord(item)) continue;
      const text = clampString(item.text, 220);
      if (text) risks.push({ id: clampString(item.id, 64) || `risk-${risks.length + 1}`, text });
    }
  }

  if (!headline && !phase && attention.length === 0 && workstreams.length === 0 && milestones.length === 0 && risks.length === 0) {
    return null;
  }

  const progressSeq = Math.max(asOfSeq ?? 0, narratorLastReadSeq);
  const stale = !narratorWorking && headSeq - progressSeq >= 10;

  return {
    updatedAt,
    asOfSeq,
    stale,
    headline,
    phase,
    attention,
    workstreams,
    milestones,
    risks,
  };
}

export interface SwarmSnapshotEngineOptions {
  dataDir?: string;
  sessionMap?: ReadonlyMap<string, string>;
  now?: () => number;
}

interface SwarmLocation {
  dataDir: string;
  swarmId: string;
  swarmDir: string;
  viewerMember: string | null;
}

interface CachedSwarmBase {
  etagBase: string;
  snapshot: Omit<SwarmSnapshotReady, 'status' | 'agentId' | 'conversationId' | 'viewerMember' | 'provider' | 'modeId' | 'etag'>;
}

export function createSwarmSnapshotEngine(options: SwarmSnapshotEngineOptions = {}) {
  const getNow = options.now ?? (() => Date.now());
  const baseCache = new Map<string, CachedSwarmBase>();
  let workerIndexCache: {
    builtAt: number;
    expiresAt: number;
    byWorkerConv: Map<string, SwarmLocation>;
  } | null = null;

  async function findSwarmLocation(conversationId: string): Promise<SwarmLocation | null> {
    const convLower = conversationId.toLowerCase();
    const dataDirs = resolveDefaultAgyDataDirs(options.dataDir);

    // 1. Direct coordinator check O(1)
    for (const dataDir of dataDirs) {
      const swarmDir = join(dataDir, 'brain', convLower, '.system_generated', 'swarm');
      try {
        const info = await stat(join(swarmDir, 'members.json'));
        if (info.isFile()) {
          return { dataDir, swarmId: convLower, swarmDir, viewerMember: 'coordinator' };
        }
      } catch {
        // Not a coordinator in this dataDir.
      }
    }

    // 2. Worker roster lookup (positive hits cached 3s; negative misses re-checked after 500ms)
    const nowMs = getNow();
    const cachedHit = workerIndexCache?.byWorkerConv.get(convLower);
    const shouldRebuild =
      !workerIndexCache ||
      nowMs >= workerIndexCache.expiresAt ||
      (!cachedHit && nowMs - workerIndexCache.builtAt >= WORKER_NEGATIVE_TTL_MS);
    if (shouldRebuild) {
      const byWorkerConv = new Map<string, SwarmLocation>();
      for (const dataDir of dataDirs) {
        let brainEntries: string[] = [];
        try {
          brainEntries = await readdir(join(dataDir, 'brain'));
        } catch {
          continue;
        }
        for (const entry of brainEntries) {
          if (!UUID_RE.test(entry)) continue;
          const swarmDir = join(dataDir, 'brain', entry, '.system_generated', 'swarm');
          const doc = await readBoundedJson<{ members?: Record<string, RawSwarmMember> }>(
            join(swarmDir, 'members.json'),
            256 * 1024,
          );
          if (!doc?.members || !isRecord(doc.members)) continue;
          for (const [memberName, member] of Object.entries(doc.members)) {
            const memberConv = typeof member?.conversation_id === 'string' ? member.conversation_id.toLowerCase() : '';
            if (UUID_RE.test(memberConv)) {
              byWorkerConv.set(memberConv, {
                dataDir,
                swarmId: entry.toLowerCase(),
                swarmDir,
                viewerMember: memberName,
              });
            }
          }
        }
      }
      workerIndexCache = { builtAt: nowMs, expiresAt: nowMs + WORKER_SCAN_TTL_MS, byWorkerConv };
    }

    return workerIndexCache?.byWorkerConv.get(convLower) ?? null;
  }

  async function resolveAgentMeta(
    agentId: string,
    paseo?: PaseoAgentsLookup,
  ): Promise<{ conversationId: string | null; provider: string | null; modeId: string | null }> {
    let conversationId = options.sessionMap?.get(agentId) ?? null;
    let provider: string | null = null;
    let modeId: string | null = null;

    if (paseo?.agents) {
      try {
        const handle = paseo.agents.ref(agentId);
        const snap = handle.current() ?? (await handle.refresh())?.agent ?? null;
        if (snap) {
          provider = snap.provider ?? null;
          modeId = snap.currentModeId ?? snap.runtimeInfo?.modeId ?? null;
          conversationId ??= extractNativeConversationId(snap);
        }
      } catch {
        // Fall back to sessionMap or direct UUID if agentId is already a conversation UUID in tests.
      }
    }

    if (!conversationId && UUID_RE.test(agentId)) {
      // Allow standalone tests to pass a native conversationId when no Paseo agent table wraps it.
      const directSwarm = await findSwarmLocation(agentId);
      if (directSwarm) conversationId = agentId.toLowerCase();
    }

    return { conversationId, provider, modeId };
  }

  async function getSnapshot(
    input: { agentId: string; etag?: string },
    paseo?: PaseoAgentsLookup,
  ): Promise<SwarmSnapshotOutput> {
    const { conversationId, provider, modeId } = await resolveAgentMeta(input.agentId, paseo);
    if (!conversationId) {
      return {
        status: 'empty',
        agentId: input.agentId,
        conversationId: null,
        provider,
        modeId,
      };
    }

    const location = await findSwarmLocation(conversationId);
    if (!location) {
      return {
        status: 'empty',
        agentId: input.agentId,
        conversationId,
        provider,
        modeId,
      };
    }

    const { dataDir, swarmId, swarmDir, viewerMember } = location;
    const membersPath = join(swarmDir, 'members.json');
    const membersDoc = await readBoundedJson<{ title?: unknown; members?: Record<string, RawSwarmMember> }>(
      membersPath,
      256 * 1024,
    );
    if (!membersDoc || !isRecord(membersDoc.members)) {
      return {
        status: 'empty',
        agentId: input.agentId,
        conversationId,
        provider,
        modeId,
      };
    }

    const rawMembersMap: Record<string, RawSwarmMember> = { ...membersDoc.members };
    if (!('coordinator' in rawMembersMap)) {
      rawMembersMap.coordinator = {
        conversation_id: swarmId,
        role: 'coordinator',
        killed: false,
      };
    } else if (!rawMembersMap.coordinator.conversation_id) {
      rawMembersMap.coordinator = { ...rawMembersMap.coordinator, conversation_id: swarmId };
    }

    const statParts: string[] = [
      swarmId,
      await fileStatKey(membersPath),
      await fileStatKey(join(swarmDir, 'board.jsonl')),
      await fileStatKey(join(swarmDir, 'plan.json')),
      await fileStatKey(join(swarmDir, 'view.json')),
    ];
    for (const [name, member] of Object.entries(rawMembersMap).sort(([a], [b]) => a.localeCompare(b))) {
      const mConv = typeof member?.conversation_id === 'string' ? member.conversation_id.toLowerCase() : '';
      const tKey = UUID_RE.test(mConv)
        ? await fileStatKey(join(dataDir, 'brain', mConv, '.system_generated', 'logs', 'transcript.jsonl'))
        : '0:0';
      statParts.push(`${name}:${tKey}`);
    }

    const etagBase = createHash('sha1').update(statParts.join('|')).digest('hex').slice(0, 16);
    const fullEtag = `${etagBase}:${viewerMember ?? 'none'}`;

    const cached = baseCache.get(swarmId);
    if (cached && cached.etagBase === etagBase) {
      if (input.etag && input.etag === fullEtag) {
        return {
          status: 'unchanged',
          agentId: input.agentId,
          conversationId,
          swarmId,
          etag: fullEtag,
          live: cached.snapshot.live,
          counts: cached.snapshot.counts,
        };
      }
      return personalizeSnapshot(cached.snapshot, {
        agentId: input.agentId,
        conversationId,
        viewerMember,
        provider,
        modeId,
        etag: fullEtag,
      });
    }

    const nowMs = getNow();
    const board = await readBoardMessages(join(swarmDir, 'board.jsonl'));
    const rosterNames = Object.keys(rawMembersMap);
    const headSeq = board.messages.at(-1)?.seq ?? 0;
    const lastPostAt = board.messages.at(-1)?.time ?? null;

    // Tally post counts & latest post per sender.
    const postStats = new Map<string, { count: number; lastSeq: number; lastTime: string | null }>();
    for (const post of board.messages) {
      const prev = postStats.get(post.agent);
      postStats.set(post.agent, {
        count: (prev?.count ?? 0) + 1,
        lastSeq: post.seq,
        lastTime: post.time ?? prev?.lastTime ?? null,
      });
    }

    const members: SwarmMember[] = [];
    const systemAttention: SwarmSystemAttention[] = [];
    let narratorLastReadSeq = 0;
    let narratorWorking = false;
    let narratorConvId: string | null = null;

    for (const [name, rawMember] of Object.entries(rawMembersMap)) {
      const memberConv =
        typeof rawMember?.conversation_id === 'string' && UUID_RE.test(rawMember.conversation_id)
          ? rawMember.conversation_id.toLowerCase()
          : null;
      const observer = isObserverMember(name, rawMember);
      const transcript = memberConv
        ? await summarizeMemberTranscript(
            join(dataDir, 'brain', memberConv, '.system_generated', 'logs', 'transcript.jsonl'),
            nowMs,
          )
        : {
            exists: false,
            mtimeMs: 0,
            size: 0,
            steps: 0,
            runState: 'none' as const,
            activity: null,
            activityKind: null,
            failure: null,
            lastProgressMs: null,
            lastTurnBoundaryMs: null,
            awaitingApproval: false,
          };

      const pendingWakeup = board.messages.some(post => postWakesMember(post, name, rawMember, rosterNames));
      const rawStatus = resolveEffectiveMemberStatus(name, rawMember, transcript, pendingWakeup);
      const status: SwarmMember['status'] =
        rawStatus === 'working' ? 'active' : rawStatus === 'killed' ? 'killed' : 'waiting';

      const lastRead =
        typeof rawMember?.last_read_seq === 'number' && Number.isInteger(rawMember.last_read_seq)
          ? rawMember.last_read_seq
          : name === 'coordinator'
            ? postStats.get('coordinator')?.lastSeq ?? 0
            : 0;
      const unread = status === 'killed' ? 0 : Math.max(0, headSeq - lastRead);
      const pStat = postStats.get(name);
      const role =
        typeof rawMember?.role === 'string' && rawMember.role.trim()
          ? rawMember.role.trim()
          : name === 'coordinator'
            ? 'coordinator'
            : /^(?:narrator)(?:-\d+)?$/i.test(name)
              ? 'narrator'
              : /^(?:monitor)(?:-\d+)?$/i.test(name)
                ? 'monitor'
                : 'worker';

      if (role === 'narrator' && status !== 'killed') {
        narratorLastReadSeq = Math.max(narratorLastReadSeq, lastRead);
        if (status === 'active') narratorWorking = true;
        narratorConvId ??= memberConv;
      }

      if (status !== 'killed' && transcript.failure) {
        systemAttention.push({
          id: `sys-${transcript.failure.kind}-${name}`,
          kind: transcript.failure.kind,
          member: name,
          conversationId: memberConv,
          text:
            transcript.failure.kind === 'quota'
              ? `@${name} hit model quota / rate limit`
              : `@${name} latest step failed`,
          detail: transcript.failure.message,
        });
      } else if (
        status === 'active' &&
        !observer &&
        transcript.lastProgressMs !== null &&
        nowMs - transcript.lastProgressMs >= STUCK_THRESHOLD_MS
      ) {
        systemAttention.push({
          id: `sys-stuck-${name}`,
          kind: 'stuck',
          member: name,
          conversationId: memberConv,
          text: `@${name} has not recorded new progress for over 10 minutes`,
          detail: transcript.activity,
        });
      }

      const channels = Array.isArray(rawMember?.channels)
        ? rawMember.channels.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : [];

      members.push({
        name,
        conversationId: memberConv,
        model: typeof rawMember?.model === 'string' && rawMember.model.trim() ? rawMember.model.trim() : null,
        role,
        isObserver: observer,
        isSelf: false,
        status,
        wakeMode: typeof rawMember?.wake_mode === 'string' && rawMember.wake_mode ? rawMember.wake_mode : null,
        channels,
        unread,
        posts: pStat?.count ?? 0,
        lastPostSeq: pStat?.lastSeq ?? null,
        lastPostTime: pStat?.lastTime ?? null,
        steps: transcript.steps,
        activity: status === 'active' ? transcript.activity : null,
        activityKind: status === 'active' ? transcript.activityKind : null,
        failure: transcript.failure ? { kind: transcript.failure.kind, message: transcript.failure.message } : null,
      });
    }

    const statusOrder: Record<SwarmMember['status'], number> = { active: 0, waiting: 1, killed: 2 };
    members.sort((a, b) => {
      const sDiff = statusOrder[a.status] - statusOrder[b.status];
      if (sDiff !== 0) return sDiff;
      if (a.name === 'coordinator') return -1;
      if (b.name === 'coordinator') return 1;
      if (a.isObserver !== b.isObserver) return a.isObserver ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const memberByName = new Map(members.map(m => [m.name.toLowerCase(), m]));
    const graphMembers = members.filter(m => !m.isObserver);

    const edgeMap = new Map<string, SwarmEdge>();
    const addEdge = (from: string, to: string, kind: 'direct' | 'channel' | 'all', seq: number) => {
      if (from.toLowerCase() === to.toLowerCase()) return;
      const key = `${from}->${to}`;
      const existing = edgeMap.get(key) ?? {
        from,
        to,
        count: 0,
        direct: 0,
        viaChannel: 0,
        viaAll: 0,
        lastSeq: seq,
      };
      existing.count += 1;
      if (kind === 'direct') existing.direct += 1;
      else if (kind === 'channel') existing.viaChannel += 1;
      else existing.viaAll += 1;
      existing.lastSeq = Math.max(existing.lastSeq, seq);
      edgeMap.set(key, existing);
    };

    const messages: SwarmMessage[] = board.messages.map(post => {
      const parsed = extractMentions(post.text, rosterNames);
      const seqRefs = extractSeqRefs(post.text).filter(seq => seq <= headSeq);
      const sender = memberByName.get(post.agent.toLowerCase());
      const canonicalFrom = sender?.name ?? post.agent;

      if (!sender?.isObserver) {
        const credited = new Set<string>();
        for (const targetName of parsed.mentions) {
          const target = memberByName.get(targetName.toLowerCase());
          if (!target || target.isObserver || target.name === canonicalFrom) continue;
          credited.add(target.name);
          addEdge(canonicalFrom, target.name, 'direct', post.seq);
        }
        if (parsed.channelMentions.length > 0) {
          for (const target of graphMembers) {
            if (target.name === canonicalFrom || credited.has(target.name)) continue;
            const inChannel =
              target.name === 'coordinator' ||
              target.channels.some(ch => parsed.channelMentions.includes(ch.toLowerCase()));
            if (inChannel) {
              credited.add(target.name);
              addEdge(canonicalFrom, target.name, 'channel', post.seq);
            }
          }
        }
        if (parsed.all) {
          for (const target of graphMembers) {
            if (target.name === canonicalFrom || credited.has(target.name)) continue;
            credited.add(target.name);
            addEdge(canonicalFrom, target.name, 'all', post.seq);
          }
        }
      }

      return {
        seq: post.seq,
        agent: canonicalFrom,
        text: post.text,
        time: post.time,
        channel: post.channel,
        mentions: parsed.mentions,
        channelMentions: parsed.channelMentions,
        seqRefs,
        all: parsed.all,
        mentionsViewer: false,
      };
    });

    const edges = [...edgeMap.values()].sort((a, b) => b.count - a.count || b.lastSeq - a.lastSeq);

    const rawPlan = await readBoundedJson(join(swarmDir, 'plan.json'));
    const plan = sanitizePlan(rawPlan);

    let rawView = await readBoundedJson(join(swarmDir, 'view.json'));
    if (!rawView && narratorConvId) {
      rawView = await readBoundedJson(join(dataDir, 'brain', narratorConvId, 'swarm_view', 'view.json'));
    }
    const view = sanitizeView(rawView, headSeq, narratorLastReadSeq, narratorWorking);

    const taskWorkers = members.filter(m => !m.isObserver && m.name !== 'coordinator');
    const activeCount = taskWorkers.filter(m => m.status === 'active').length;
    const waitingCount = taskWorkers.filter(m => m.status === 'waiting').length;
    const killedCount = taskWorkers.filter(m => m.status === 'killed').length;
    const coordinatorActive = members.find(m => m.name === 'coordinator')?.status === 'active';
    const live = activeCount > 0 || Boolean(coordinatorActive);

    const baseSnapshot: CachedSwarmBase['snapshot'] = {
      swarmId,
      title: clampString(membersDoc.title, 120) || 'Antigravity Swarm',
      live,
      headSeq,
      lastPostAt,
      counts: {
        active: activeCount,
        waiting: waitingCount,
        killed: killedCount,
        messages: messages.length,
        alerts: systemAttention.length + (view?.attention.length ?? 0),
      },
      members,
      messages,
      edges,
      plan,
      view,
      systemAttention,
    };

    baseCache.set(swarmId, { etagBase, snapshot: baseSnapshot });

    if (input.etag && input.etag === fullEtag) {
      return {
        status: 'unchanged',
        agentId: input.agentId,
        conversationId,
        swarmId,
        etag: fullEtag,
        live,
        counts: baseSnapshot.counts,
      };
    }

    return personalizeSnapshot(baseSnapshot, {
      agentId: input.agentId,
      conversationId,
      viewerMember,
      provider,
      modeId,
      etag: fullEtag,
    });
  }

  return { getSnapshot };
}

function personalizeSnapshot(
  base: CachedSwarmBase['snapshot'],
  ctx: {
    agentId: string;
    conversationId: string;
    viewerMember: string | null;
    provider: string | null;
    modeId: string | null;
    etag: string;
  },
): SwarmSnapshotReady {
  const viewerLower = ctx.viewerMember?.toLowerCase() ?? '';
  return {
    status: 'ready',
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
    swarmId: base.swarmId,
    viewerMember: ctx.viewerMember,
    provider: ctx.provider,
    modeId: ctx.modeId,
    title: base.title,
    etag: ctx.etag,
    live: base.live,
    headSeq: base.headSeq,
    lastPostAt: base.lastPostAt,
    counts: base.counts,
    members: base.members.map(m => ({
      ...m,
      isSelf: viewerLower !== '' && m.name.toLowerCase() === viewerLower,
    })),
    messages: base.messages.map(msg => ({
      ...msg,
      mentionsViewer:
        viewerLower !== '' &&
        msg.agent.toLowerCase() !== viewerLower &&
        msg.mentions.some(m => m.toLowerCase() === viewerLower),
    })),
    edges: base.edges,
    plan: base.plan,
    view: base.view,
    systemAttention: base.systemAttention,
  };
}
