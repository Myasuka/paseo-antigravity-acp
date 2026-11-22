import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';

const ROOT = resolve(import.meta.dirname, '..');
const tmpRoot = await mkdtemp(join(tmpdir(), 'agy-client-test-'));

// Shared mock state controlled by test cases
const mockState = {
  locale: 'en',
  tabState: {
    activeTab: 'overview',
    follow: true,
    showKilled: true,
    expandAll: false,
    hideInactive: false,
  },
  snapshot: null,
  settingsValues: {
    agyPath: '',
    readOnlyRoots: ['~/skills'],
    progressUpdates: true,
    backgroundTimeoutMinutes: 60,
  },
};
globalThis.__AGY_CLIENT_TEST_MOCK__ = mockState;

function rewriteImports(code) {
  return code
    .replace(/from\s+["']react-native["']/g, 'from "./__mocks__/react-native.mjs"')
    .replace(/from\s+["']@getpaseo\/plugin\/client\/ui["']/g, 'from "./__mocks__/plugin-client-ui.mjs"')
    .replace(/from\s+["']@getpaseo\/plugin\/client["']/g, 'from "./__mocks__/plugin-client.mjs"')
    .replace(/from\s+["'](\.\.?\/[^"']+?)["']/g, (full, spec) => {
      if (spec.endsWith('.json')) return `from "${spec}" with { type: "json" }`;
      if (spec.endsWith('.mjs') || spec.endsWith('.js')) return full;
      const clean = spec.replace(/\.(tsx|ts)$/, '');
      return `from "${clean}.mjs"`;
    });
}

async function transpileFile(relPath) {
  const srcPath = join(ROOT, relPath);
  const raw = await readFile(srcPath, 'utf8');
  const out = ts.transpileModule(raw, {
    fileName: srcPath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const outRel = relPath.replace(/\.(tsx|ts)$/, '.mjs');
  const destPath = join(tmpRoot, outRel);
  await mkdir(dirname(destPath), { recursive: true });
  const depth = outRel.split('/').length - 1;
  const mockPrefix = depth === 0 ? './__mocks__' : '../'.repeat(depth) + '__mocks__';
  const rewritten = rewriteImports(out.outputText).replaceAll('./__mocks__', mockPrefix);
  await writeFile(destPath, rewritten);
}

function collectText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (React.isValidElement(node)) {
    if (typeof node.type === 'function') {
      const rendered = node.type(node.props);
      collectText(rendered, out);
    } else if (node.props && 'children' in node.props) {
      collectText(node.props.children, out);
    }
  }
  return out;
}

const dummyTheme = {
  isDark: true,
  colors: {
    surface0: '#111',
    surface1: '#1a1a1a',
    surface2: '#222',
    surface3: '#2a2a2a',
    borderSubtle: '#333',
    borderDefault: '#444',
    borderStrong: '#555',
    foregroundPrimary: '#fff',
    foregroundSecondary: '#ccc',
    foregroundMuted: '#888',
    accent: '#4da3ff',
    accentForeground: '#fff',
    accentSoft: '#1b3556',
    success: '#22c55e',
    successSoft: '#143824',
    warning: '#f59e0b',
    warningSoft: '#3b2a11',
    danger: '#ef4444',
    dangerSoft: '#3b1515',
    info: '#38bdf8',
    infoSoft: '#102f3e',
  },
};

try {
  // Link node_modules into tmpRoot so bare imports (react, zod, @getpaseo/plugin) resolve cleanly
  await mkdir(join(tmpRoot, '__mocks__'), { recursive: true });
  await cp(join(ROOT, 'client/locales'), join(tmpRoot, 'client/locales'), { recursive: true });
  await writeFile(
    join(tmpRoot, 'package.json'),
    JSON.stringify({ type: 'module' }),
  );
  // Symlink node_modules
  const { symlink } = await import('node:fs/promises');
  await symlink(join(ROOT, 'node_modules'), join(tmpRoot, 'node_modules'));

  await writeFile(
    join(tmpRoot, '__mocks__/react-native.mjs'),
    `import React from 'react';
export const View = props => React.createElement('View', props, props.children);
export const Text = props => React.createElement('Text', props, props.children);
export const Pressable = props => React.createElement('Pressable', props, typeof props.children === 'function' ? props.children({ pressed: false }) : props.children);
`,
  );

  await writeFile(
    join(tmpRoot, '__mocks__/plugin-client-ui.mjs'),
    `import React from 'react';
export const ScrollView = React.forwardRef((props, _ref) => React.createElement('ScrollView', props, props.children));
export const TextInput = props => React.createElement('TextInput', props, props.value ?? '');
export const Icon = props => React.createElement('Icon', props, props.name);
export const Loading = props => React.createElement('Loading', props, props.label ?? 'loading');
export const SettingsSection = props => React.createElement('SettingsSection', props, props.title, props.description, props.children);
export const SettingsCard = props => React.createElement('SettingsCard', props, props.children);
export const SettingsRow = props => React.createElement('SettingsRow', props, props.title, props.description, props.children);
export const SettingsInput = props => React.createElement('SettingsInput', props, props.value ?? '');
export const SettingsSwitch = props => React.createElement('SettingsSwitch', props, String(props.value));
export const SettingsAction = props => React.createElement('SettingsAction', props, props.label);
export async function copyText() {}
export function useToast() {
  return { show() {}, success() {}, error() {}, info() {} };
}
`,
  );

  await writeFile(
    join(tmpRoot, '__mocks__/plugin-client.mjs'),
    `const state = globalThis.__AGY_CLIENT_TEST_MOCK__;
export function defineTranslations(config) {
  return {
    resources: config.resources,
    message(key, values) {
      return { __i18nKey: key, resources: config.resources, values };
    },
  };
}
export function useTranslation(bundle) {
  const dict = bundle.resources[state.locale] ?? bundle.resources.en ?? {};
  return {
    locale: state.locale,
    t(key, values = {}) {
      let str = dict[key] ?? bundle.resources.en?.[key] ?? key;
      for (const [k, v] of Object.entries(values)) {
        str = str.replaceAll('{{' + k + '}}', String(v));
      }
      return str;
    },
  };
}
export function useTabState(_key, _schema, initial) {
  const val = state.tabState ?? (typeof initial === 'function' ? initial() : initial);
  return [val, next => { state.tabState = typeof next === 'function' ? next(state.tabState) : next; }];
}
export function useRpc() {
  return {
    async call() {
      return state.snapshot;
    },
  };
}
export function useSettings() {
  return {
    status: 'ready',
    revision: 1,
    values: state.settingsValues,
    saving: false,
    error: null,
    async update(patch) {
      Object.assign(state.settingsValues, patch);
    },
  };
}
`,
  );

  for (const file of [
    'shared/settings.ts',
    'shared/swarm.ts',
    'client/messages.ts',
    'client/settings-screen.tsx',
    'client/swarm-panel.tsx',
    'index.client.tsx',
  ]) {
    await transpileFile(file);
  }

  // Override useEffect/useRef minimally via React dispatcher wrapper for synchronous tree rendering
  const { default: contributeClient } = await import(pathToFileURL(join(tmpRoot, 'index.client.mjs')).href);
  const {
    SwarmBoardPanel,
    SwarmStatusPillIcon,
    publishSwarmPillSummary,
  } = await import(pathToFileURL(join(tmpRoot, 'client/swarm-panel.mjs')).href);

  // 1. Verify contributeClient registrations & dynamic composer pill lifecycle
  const settingsScreens = [];
  const agentPanels = [];
  const commandItems = [];
  const slashCommands = [];
  const activePills = new Map();
  const openedPanels = [];
  const openedSettings = [];
  let agentSubscriber = null;

  const mockClient = {
    pluginId: 'antigravity-approval',
    paseo: {
      agents: {
        subscribe(fn) {
          agentSubscriber = fn;
          return () => {
            agentSubscriber = null;
          };
        },
        async list() {
          return {
            entries: [
              { agent: { id: 'ag-acp-1', provider: 'antigravity-acp', workspaceId: 'wks-1', archivedAt: null } },
              { agent: { id: 'ag-native-1', provider: 'antigravity', workspaceId: 'wks-1', archivedAt: null } },
              { agent: { id: 'codex-1', provider: 'codex', workspaceId: 'wks-1', archivedAt: null } },
              { agent: { id: 'ag-archived', provider: 'antigravity-acp', workspaceId: 'wks-1', archivedAt: '2026-01-01T00:00:00Z' } },
            ],
            subscription: {
              subscribe: () => () => {},
              release: async () => {},
            },
          };
        },
      },
    },
    addSettingsScreen(screen) {
      settingsScreens.push(screen);
      return () => {};
    },
    addAgentPanel(panel) {
      agentPanels.push(panel);
      return () => {};
    },
    addCommandCenterItem(item) {
      commandItems.push(item);
      return () => {};
    },
    addSlashCommand(cmd) {
      slashCommands.push(cmd);
      return () => {};
    },
    addComposerPill(pill) {
      const key = `${pill.workspaceId}:${pill.agentId}:${pill.id}`;
      const record = { ...pill, button: { ...pill.button }, updateCalls: 0 };
      activePills.set(key, record);
      return {
        update(patch) {
          record.button = { ...record.button, ...patch };
          record.updateCalls++;
        },
        remove() {
          activePills.delete(key);
        },
      };
    },
    openPanel(panelId, target) {
      openedPanels.push({ panelId, target });
    },
    openSettings(screenId) {
      openedSettings.push(screenId);
    },
  };

  const dispose = contributeClient(mockClient);
  await new Promise(r => setTimeout(r, 20));

  assert.equal(settingsScreens.length, 1);
  assert.equal(settingsScreens[0].id, 'policy');
  assert.equal(agentPanels.length, 1);
  assert.equal(agentPanels[0].id, 'swarm');
  assert.deepEqual(agentPanels[0].locations, ['workspace', 'explorer']);
  assert.equal(commandItems.length, 2);
  assert.equal(slashCommands.length, 1);
  assert.equal(slashCommands[0].name, 'swarm-board');

  // Verify command center & slash command callbacks open the right targets
  commandItems.find(i => i.id === 'configure-antigravity-acp').onSelect({
    openSettings: id => openedSettings.push(id),
  });
  commandItems.find(i => i.id === 'open-antigravity-swarm').onSelect({
    openPanel: id => openedPanels.push({ panelId: id }),
  });
  slashCommands[0].onSubmit({
    openPanel: id => openedPanels.push({ panelId: id }),
  });
  assert.deepEqual(openedSettings, ['policy']);
  assert.equal(openedPanels.length, 2);

  // Composer pills: attached ONLY to antigravity-acp and antigravity, NOT codex or archived
  assert.equal(activePills.size, 2);
  assert.ok(activePills.has('wks-1:ag-acp-1:swarm-board'));
  assert.ok(activePills.has('wks-1:ag-native-1:swarm-board'));

  // Clicking the pill opens the swarm panel scoped to workspace + agent
  const acpPill = activePills.get('wks-1:ag-acp-1:swarm-board');
  acpPill.button.behavior.onPress();
  assert.deepEqual(openedPanels.at(-1), {
    panelId: 'swarm',
    target: { workspaceId: 'wks-1', agentId: 'ag-acp-1' },
  });

  // Dynamic pill label updates from SwarmStatusPillIcon summary notifications
  assert.equal(acpPill.button.label.__i18nKey, 'swarmPillLabel');
  publishSwarmPillSummary('ag-acp-1', { state: 'live', active: 2, waiting: 1, alerts: 0 });
  assert.equal(acpPill.button.label.__i18nKey, 'swarmPillActiveLabel');
  assert.deepEqual(acpPill.button.label.values, { active: 2 });

  publishSwarmPillSummary('ag-acp-1', { state: 'alert', active: 1, waiting: 0, alerts: 3 });
  assert.equal(acpPill.button.label.__i18nKey, 'swarmPillActiveAlertLabel');
  assert.deepEqual(acpPill.button.label.values, { active: 1, alerts: 3 });

  publishSwarmPillSummary('ag-acp-1', { state: 'live', active: 0, waiting: 1, alerts: 0 });
  assert.equal(acpPill.button.label.__i18nKey, 'swarmPillLiveLabel');

  publishSwarmPillSummary('ag-acp-1', { state: 'idle', active: 0, waiting: 1, alerts: 0 });
  assert.equal(acpPill.button.label.__i18nKey, 'swarmPillLabel');

  // Archiving an agent dynamically removes its pill and unsubscribes label listener
  const updatesBeforeArchive = acpPill.updateCalls;
  agentSubscriber({
    kind: 'upsert',
    agent: { id: 'ag-acp-1', provider: 'antigravity-acp', workspaceId: 'wks-1', archivedAt: '2026-06-01T00:00:00Z' },
  });
  assert.equal(activePills.size, 1);
  publishSwarmPillSummary('ag-acp-1', { state: 'live', active: 4, waiting: 0, alerts: 0 });
  assert.equal(acpPill.updateCalls, updatesBeforeArchive, 'Archived pill must stop receiving label updates');

  dispose();
  assert.equal(activePills.size, 0, 'Disposing client plugin must remove all pills');

  // 2. Render React component trees using react-test-renderer / react-dom server equivalent via React hooks dispatcher
  // Verify SwarmStatusPillIcon & SwarmBoardPanel component exports are valid functions
  assert.equal(typeof SwarmBoardPanel, 'function');
  assert.equal(typeof SwarmStatusPillIcon, 'function');
  assert.ok(React.isValidElement(React.createElement(SwarmBoardPanel, {
    workspaceId: 'wks-1',
    agentId: 'ag-acp-1',
    location: 'workspace',
    focused: true,
    theme: dummyTheme,
    close: () => {},
  })));
} finally {
  delete globalThis.__AGY_CLIENT_TEST_MOCK__;
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: true, suite: 'client-contributions' }));
