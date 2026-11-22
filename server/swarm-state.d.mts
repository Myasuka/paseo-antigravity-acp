export const UUID_RE: RegExp;
export const APPROVAL_SENSITIVE_TOOLS: ReadonlySet<string>;
export const SWARM_TOOLS: ReadonlySet<string>;
export const DEFAULT_SWARM_WORKER_STALE_MS: number;

export interface RawSwarmMember {
  conversation_id?: string;
  model?: string;
  role?: string;
  wake_mode?: string;
  wait_since?: number | string | null;
  last_read_seq?: number;
  last_nudged_seq?: number;
  killed?: boolean;
  channels?: string[];
}

export interface RawBoardPost {
  seq: number;
  agent: string;
  text: string;
  time: string | null;
  channel: string;
  control: boolean;
}

export interface MemberTranscriptFailure {
  kind: 'quota' | 'error';
  message: string;
  timestampMs: number | null;
}

export interface MemberTranscriptSummary {
  exists: boolean;
  mtimeMs: number;
  size: number;
  steps: number;
  runState: 'working' | 'waiting' | 'none';
  activity: string | null;
  activityKind: 'tool' | 'thinking' | null;
  failure: MemberTranscriptFailure | null;
  lastProgressMs: number | null;
  lastTurnBoundaryMs: number | null;
  hasPostInitialWakeup?: boolean;
  awaitingApproval: boolean;
  pendingBackgroundCount?: number;
  backgroundTaskBytes?: number;
  backgroundProgressKey?: string;
}

export interface SwarmProgressWorker {
  name: string;
  status: 'active' | 'waiting' | 'stale';
  activity: string | null;
  steps: number;
  lastActivityMs: number | null;
  taskLogBytes: number;
  awaitingApproval: boolean;
  failure: string | null;
}

export interface SwarmProgressLatestPost {
  seq: number;
  agent: string;
  channel: string;
  preview: string;
  time: string | null;
}

export interface SwarmProgressSummary {
  title: string | null;
  headSeq: number;
  activeCount: number;
  waitingCount: number;
  staleCount: number;
  hasPendingWakeup: boolean;
  awaitingApproval: boolean;
  lastActivityMs: number | null;
  workers: SwarmProgressWorker[];
  latestPost: SwarmProgressLatestPost | null;
}

export interface ObservedSwarmWorkerProgress {
  progressKey: string;
  observedAtMs: number | null;
}

export interface SwarmWorkingWorkerState {
  name: string;
  conversationId: string | null;
  key: string;
  progressKey: string;
  lastActivityMs: number | null;
  awaitingApproval: boolean;
  pendingWakeup: boolean;
  stale: boolean;
}

export interface SwarmContinuationState {
  exists: boolean;
  active: boolean;
  activeWorkerConversations: string[];
  staleWorkerConversations?: string[];
  hasWorkingTaskWorkers?: boolean;
  hasPendingWakeup?: boolean;
  awaitingApproval?: boolean;
  workingWorkers?: SwarmWorkingWorkerState[];
  signature?: string | null;
  progress?: SwarmProgressSummary | null;
}

export function isObserverMember(name: string, member?: RawSwarmMember | null): boolean;
export function extractMentions(
  text: string,
  rosterNames?: readonly string[],
): { mentions: string[]; channelMentions: string[]; all: boolean };
export function extractSeqRefs(text: string): number[];
export function summarizeMemberTranscript(transcriptPath: string, nowMs?: number): Promise<MemberTranscriptSummary>;
export function resolveEffectiveMemberStatus(
  name: string,
  member: RawSwarmMember | undefined,
  transcriptSummary: MemberTranscriptSummary,
  hasPendingWakeup?: boolean,
): 'working' | 'waiting' | 'killed';
export function readBoundedJson<T = unknown>(filePath: string, maxBytes?: number): Promise<T | null>;
export function readBoardMessages(
  boardPath: string,
  maxBytes?: number,
): Promise<{ messages: RawBoardPost[]; mtimeMs: number; size: number }>;
export function postWakesMember(
  post: RawBoardPost,
  name: string,
  member: RawSwarmMember | undefined,
  rosterNames: readonly string[],
): boolean;
export function inspectSwarmContinuation(options: {
  dataDir: string;
  sessionId: string;
  nowMs?: number;
  wakeupGraceMs?: number;
  workerStaleMs?: number;
  observedWorkers?: Map<string, ObservedSwarmWorkerProgress> | null;
}): Promise<SwarmContinuationState>;
