import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const SwarmCountsSchema = z.object({
  active: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  killed: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
});

export const SwarmMemberFailureSchema = z.object({
  kind: z.enum(['quota', 'error']),
  message: z.string(),
});

export const SwarmMemberSchema = z.object({
  name: z.string(),
  conversationId: z.string().nullable(),
  model: z.string().nullable(),
  role: z.string(),
  isObserver: z.boolean(),
  isSelf: z.boolean(),
  status: z.enum(['active', 'waiting', 'killed']),
  wakeMode: z.string().nullable(),
  channels: z.array(z.string()),
  unread: z.number().int().nonnegative(),
  posts: z.number().int().nonnegative(),
  lastPostSeq: z.number().int().nullable(),
  lastPostTime: z.string().nullable(),
  steps: z.number().int().nonnegative(),
  activity: z.string().nullable(),
  activityKind: z.enum(['tool', 'thinking']).nullable(),
  failure: SwarmMemberFailureSchema.nullable(),
});

export const SwarmMessageSchema = z.object({
  seq: z.number().int().positive(),
  agent: z.string(),
  text: z.string(),
  time: z.string().nullable(),
  channel: z.string(),
  mentions: z.array(z.string()),
  channelMentions: z.array(z.string()),
  seqRefs: z.array(z.number().int().positive()),
  all: z.boolean(),
  mentionsViewer: z.boolean(),
});

export const SwarmEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  count: z.number().int().positive(),
  direct: z.number().int().nonnegative(),
  viaChannel: z.number().int().nonnegative(),
  viaAll: z.number().int().nonnegative(),
  lastSeq: z.number().int().positive(),
});

export const SwarmPlanSchema = z.object({
  goal: z
    .object({
      title: z.string(),
      line: z.string(),
    })
    .nullable(),
  tasks: z.record(z.string(), z.string()),
  threads: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      goal: z.string(),
      tasks: z.array(z.string()),
    }),
  ),
});

export const SwarmViewAttentionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.enum(['high', 'med', 'low']),
  title: z.string(),
  why: z.string(),
  seqRefs: z.array(z.number().int().positive()),
  memberRefs: z.array(z.string()),
});

export const SwarmViewSchema = z.object({
  updatedAt: z.string().nullable(),
  asOfSeq: z.number().int().nullable(),
  stale: z.boolean(),
  headline: z.string().nullable(),
  phase: z
    .object({
      label: z.string(),
      index: z.number().int(),
      total: z.number().int(),
    })
    .nullable(),
  attention: z.array(SwarmViewAttentionSchema),
  workstreams: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.string(),
      owners: z.array(z.string()),
      note: z.string(),
    }),
  ),
  milestones: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
  risks: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    }),
  ),
});

export const SwarmSystemAttentionSchema = z.object({
  id: z.string(),
  kind: z.enum(['quota', 'error', 'stuck']),
  member: z.string(),
  conversationId: z.string().nullable(),
  text: z.string(),
  detail: z.string().nullable(),
});

export const SwarmSnapshotInputSchema = z.object({
  agentId: z.string().min(1),
  etag: z.string().optional(),
});

export const SwarmSnapshotEmptySchema = z.object({
  status: z.literal('empty'),
  agentId: z.string(),
  conversationId: z.string().nullable(),
  provider: z.string().nullable(),
  modeId: z.string().nullable(),
});

export const SwarmSnapshotUnchangedSchema = z.object({
  status: z.literal('unchanged'),
  agentId: z.string(),
  conversationId: z.string(),
  swarmId: z.string(),
  etag: z.string(),
  live: z.boolean(),
  counts: SwarmCountsSchema,
});

export const SwarmSnapshotReadySchema = z.object({
  status: z.literal('ready'),
  agentId: z.string(),
  conversationId: z.string(),
  swarmId: z.string(),
  viewerMember: z.string().nullable(),
  provider: z.string().nullable(),
  modeId: z.string().nullable(),
  title: z.string(),
  etag: z.string(),
  live: z.boolean(),
  headSeq: z.number().int().nonnegative(),
  lastPostAt: z.string().nullable(),
  counts: SwarmCountsSchema,
  members: z.array(SwarmMemberSchema),
  messages: z.array(SwarmMessageSchema),
  edges: z.array(SwarmEdgeSchema),
  plan: SwarmPlanSchema.nullable(),
  view: SwarmViewSchema.nullable(),
  systemAttention: z.array(SwarmSystemAttentionSchema),
});

export const SwarmSnapshotOutputSchema = z.discriminatedUnion('status', [
  SwarmSnapshotEmptySchema,
  SwarmSnapshotUnchangedSchema,
  SwarmSnapshotReadySchema,
]);

export type SwarmCounts = z.output<typeof SwarmCountsSchema>;
export type SwarmMember = z.output<typeof SwarmMemberSchema>;
export type SwarmMessage = z.output<typeof SwarmMessageSchema>;
export type SwarmEdge = z.output<typeof SwarmEdgeSchema>;
export type SwarmPlan = z.output<typeof SwarmPlanSchema>;
export type SwarmView = z.output<typeof SwarmViewSchema>;
export type SwarmSystemAttention = z.output<typeof SwarmSystemAttentionSchema>;
export type SwarmSnapshotEmpty = z.output<typeof SwarmSnapshotEmptySchema>;
export type SwarmSnapshotUnchanged = z.output<typeof SwarmSnapshotUnchangedSchema>;
export type SwarmSnapshotReady = z.output<typeof SwarmSnapshotReadySchema>;
export type SwarmSnapshotOutput = z.output<typeof SwarmSnapshotOutputSchema>;

export const swarmSnapshotRpc = defineRpc({
  name: 'swarm.snapshot',
  input: SwarmSnapshotInputSchema,
  output: SwarmSnapshotOutputSchema,
});
