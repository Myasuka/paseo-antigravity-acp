import type { ProviderTimelineItem } from '@getpaseo/plugin/server/provider';

export interface HistoryTimestampEntry {
  kind: 'user_message' | 'reasoning' | 'assistant_message' | 'tool_call';
  textPrefix?: string;
  isExplicit?: boolean;
  name?: string;
  timestamp: string;
}

export interface BuildHistoryTimestampEntriesOptions {
  fileMtimeMs?: number;
  maxFinalStepDurationMs?: number;
}

export interface LoadHistoryTimestampMatcherOptions {
  nativeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

export function resolveAgyDataDir(env?: NodeJS.ProcessEnv): string;

export function buildHistoryTimestampEntries(
  rows: readonly Record<string, unknown>[],
  options?: BuildHistoryTimestampEntriesOptions,
): HistoryTimestampEntry[];

export class HistoryTimestampMatcher {
  constructor(entries: readonly HistoryTimestampEntry[]);
  match(item: ProviderTimelineItem | null | undefined): string | undefined;
}

export function loadHistoryTimestampMatcher(
  options?: LoadHistoryTimestampMatcherOptions,
): Promise<HistoryTimestampMatcher | null>;
