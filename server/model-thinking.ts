import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AcpTransformer } from '@getpaseo/plugin/server/acp';
import type { ProviderThinkingOption } from '@getpaseo/plugin/server/provider';
import { resolveAgyBinary } from './resolve-agy.mjs';

export interface ResolvedModelThinking {
  thinkingOptions?: ProviderThinkingOption[];
  defaultThinkingOptionId?: string;
}

interface RawOptionCandidate {
  value?: unknown;
  name?: unknown;
  group?: unknown;
  options?: unknown;
}

interface RawConfigOption {
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenOptions(rawOptions: unknown): Array<{ value: string; name: string }> {
  if (!Array.isArray(rawOptions)) return [];
  const items: Array<{ value: string; name: string }> = [];
  for (const candidate of rawOptions as RawOptionCandidate[]) {
    if (!isRecord(candidate)) continue;
    if ('group' in candidate && Array.isArray(candidate.options)) {
      for (const nested of candidate.options as RawOptionCandidate[]) {
        if (isRecord(nested) && typeof nested.value === 'string' && typeof nested.name === 'string') {
          items.push({ value: nested.value, name: nested.name });
        }
      }
    } else if (typeof candidate.value === 'string' && typeof candidate.name === 'string') {
      items.push({ value: candidate.value, name: candidate.name });
    }
  }
  return items;
}

export function extractThinkingFromConfigOptions(configOptions: unknown): ResolvedModelThinking {
  if (!Array.isArray(configOptions)) return {};
  const thought = (configOptions as RawConfigOption[]).find(
    option => isRecord(option) && (option.category === 'thought_level' || option.id === 'thought_level'),
  );
  if (!thought || thought.type === 'boolean') return {};
  const rawItems = flattenOptions(thought.options);
  if (rawItems.length === 0) return {};
  const currentValue = typeof thought.currentValue === 'string' ? thought.currentValue : undefined;
  const defaultThinkingOptionId =
    currentValue && rawItems.some(item => item.value === currentValue) ? currentValue : rawItems[0]?.value;
  const thinkingOptions: ProviderThinkingOption[] = rawItems.map(item => ({
    id: item.value,
    label: item.name,
    ...(item.value === defaultThinkingOptionId ? { isDefault: true } : {}),
  }));
  return { thinkingOptions, defaultThinkingOptionId };
}

export interface ProbeAgyModelThinkingOptions {
  command?: string;
  configuredPath?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

/**
 * AGY exposes per-model `thought_level` options only when that model is selected in an ACP session
 * (e.g. `gemini-4-hydrogen` adds `xhigh` / "Extra", while `gemini-pro-orchestrator*` and
 * `gpt-oss-120b-medium` omit `thought_level` altogether). Probe each model once during catalog discovery.
 */
export async function probeAgyModelThinking(
  modelIds: readonly string[],
  options: ProbeAgyModelThinkingOptions = {},
): Promise<Map<string, ResolvedModelThinking>> {
  const result = new Map<string, ResolvedModelThinking>();
  if (modelIds.length === 0) return result;

  const command =
    options.command ?? resolveAgyBinary({ configuredPath: options.configuredPath, env: process.env }).path ?? 'agy';
  const args = options.args ?? ['acp', '--process-per-session'];
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 25000;

  const child = spawn(command, [...args], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });

  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.on('error', err => failAll(err instanceof Error ? err : new Error(String(err))));
  child.on('close', (code, signal) => {
    failAll(new Error(`AGY catalog probe exited (${signal ?? code ?? 'unknown'})`));
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number' && !('method' in message)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (isRecord(message.error)) {
          waiter.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'ACP error'));
        } else {
          waiter.resolve(message.result);
        }
      }
    } catch (error) {
      failAll(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (child.stdin.destroyed) {
        reject(new Error('AGY catalog probe stdin is closed'));
        return;
      }
      const id = nextId++;
      pending.set(id, {
        resolve: value => resolve(isRecord(value) ? value : {}),
        reject,
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('AGY model thinking probe timed out')), timeoutMs);
  });

  const terminate = () => {
    rl.close();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  };

  try {
    await Promise.race([
      (async () => {
        await rpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'paseo-agy-catalog', version: '1' },
        });
        const opened = await rpc('session/new', { cwd, mcpServers: [] });
        const sessionId = typeof opened.sessionId === 'string' ? opened.sessionId : '';
        if (!sessionId) throw new Error('AGY catalog probe returned no sessionId');

        const initialOptions = Array.isArray(opened.configOptions) ? (opened.configOptions as RawConfigOption[]) : [];
        const modelOption = initialOptions.find(
          option => isRecord(option) && (option.category === 'model' || option.id === 'model'),
        );
        const modelConfigId = typeof modelOption?.id === 'string' ? modelOption.id : 'model';
        const initialModel = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
        if (initialModel && modelIds.includes(initialModel)) {
          result.set(initialModel, extractThinkingFromConfigOptions(initialOptions));
        }

        for (const modelId of modelIds) {
          if (result.has(modelId)) continue;
          const updated = await rpc('session/set_config_option', {
            sessionId,
            configId: modelConfigId,
            value: modelId,
          });
          result.set(modelId, extractThinkingFromConfigOptions(updated.configOptions));
        }
      })(),
      deadlinePromise,
    ]);
    return result;
  } finally {
    clearTimeout(deadlineTimer);
    terminate();
  }
}

export function createModelThinkingTransformer(
  probe: (modelIds: readonly string[]) => Promise<Map<string, ResolvedModelThinking>> = modelIds =>
    probeAgyModelThinking(modelIds),
): AcpTransformer {
  return {
    async discover(catalog) {
      if (catalog.models.length === 0) return catalog;
      try {
        const byModel = await probe(catalog.models.map(model => model.id));
        if (byModel.size === 0) return catalog;
        return {
          ...catalog,
          thinkingOptions: undefined,
          defaultThinkingOption: undefined,
          models: catalog.models.map(model => {
            const resolved = byModel.get(model.id);
            if (!resolved) {
              return {
                ...model,
                thinkingOptions:
                  model.thinkingOptions ?? (catalog.thinkingOptions ? [...catalog.thinkingOptions] : undefined),
                defaultThinkingOptionId: model.defaultThinkingOptionId ?? catalog.defaultThinkingOption,
              };
            }
            return {
              ...model,
              thinkingOptions: resolved.thinkingOptions,
              defaultThinkingOptionId: resolved.defaultThinkingOptionId,
            };
          }),
        };
      } catch {
        return catalog;
      }
    },
    async configure(change, context) {
      if (change.target !== 'thinking') return 'pass';
      const values = await context.config.read();
      // Models such as gemini-pro-orchestrator* and gpt-oss-120b-medium omit thought_level.
      if (!('thought_level' in values)) return 'handled';
      if (change.value === null) {
        if (values.thought_level !== 'medium') {
          await context.config.set('thought_level', 'medium');
        }
        return 'handled';
      }
      return 'pass';
    },
  };
}
