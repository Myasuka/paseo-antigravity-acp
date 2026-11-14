import type { PluginServerContext } from '@getpaseo/plugin/server';
import { antigravitySettings, DEFAULT_READ_ONLY_ROOTS } from './shared/settings.ts';
import { swarmSnapshotRpc } from './shared/swarm.ts';
import { createDetailedAgyProvider } from './server/tool-presentation.ts';
import { failedToolErrors } from './server/failed-tools.ts';
import { createModelThinkingTransformer, probeAgyModelThinking } from './server/model-thinking.ts';
import { createSwarmSnapshotEngine } from './server/swarm-snapshot.ts';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(antigravitySettings);
  const sessionMap = new Map<string, string>();
  const swarmEngine = createSwarmSnapshotEngine({ sessionMap });

  server.handle(swarmSnapshotRpc, async (input, context) => {
    return swarmEngine.getSnapshot(input, context.paseo);
  });

  const readValues = async () => {
    const state = await settings.read();
    return state.status === 'ready'
      ? state.values
      : { agyPath: '', readOnlyRoots: [], progressUpdates: true, backgroundTimeoutMinutes: 60 };
  };

  const resolveRuntimeEnv = async (): Promise<Record<string, string>> => {
    const values = await readValues();
    const env: Record<string, string> = {
      PASEO_AGY_PROGRESS_UPDATES: values.progressUpdates ? '1' : '0',
      PASEO_AGY_BACKGROUND_TIMEOUT_MS: String(values.backgroundTimeoutMinutes * 60 * 1000),
    };
    if (values.agyPath) env.PASEO_AGY_BIN = values.agyPath;
    if (values.readOnlyRoots.length > 0) {
      env.PASEO_AGY_EXTRA_READ_ROOTS = JSON.stringify(values.readOnlyRoots);
    }
    return env;
  };

  const resolveConfiguredAgyPath = async () => {
    const values = await readValues();
    return values.agyPath;
  };

  server.registerProvider(
    createDetailedAgyProvider(
      {
        id: 'antigravity-acp',
        label: 'Antigravity · ACP',
        description:
          'Interactive tool approvals, realpath-checked skill read policy, explicit Full access, per-model thinking, and background/Swarm continuation.',
        acpOptions: { startupTimeoutMs: 45000, waitForInitialCommands: true, initialCommandsTimeoutMs: 3000 },
        transformers: [
          failedToolErrors,
          createModelThinkingTransformer(async modelIds => {
            const configuredPath = await resolveConfiguredAgyPath();
            return probeAgyModelThinking(modelIds, { configuredPath });
          }),
          {
            discover(catalog) {
              return {
                ...catalog,
                modes: catalog.modes.map(mode =>
                  mode.id === 'full-access'
                    ? { ...mode, icon: 'ShieldOff', colorTier: 'dangerous', isUnattended: true }
                    : mode,
                ),
              };
            },
          },
        ],
      },
      {
        resolveRuntimeEnv,
        resolveConfiguredAgyPath,
        defaultReadOnlyRoots: DEFAULT_READ_ONLY_ROOTS,
        onSessionPersistence(sessionId, nativeSessionId) {
          sessionMap.set(sessionId, nativeSessionId.toLowerCase());
        },
      },
    ),
  );

  return () => {
    sessionMap.clear();
  };
}
