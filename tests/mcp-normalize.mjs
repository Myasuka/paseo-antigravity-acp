import assert from 'node:assert/strict';
import { normalizeMcpServersList, normalizeMcpServersMessage } from '../server/mcp-normalize.mjs';

// 1. Remote HTTP / Streamable-HTTP / SSE header and type normalization without mutating input
{
  const original = {
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/work',
      mcpServers: [
        {
          name: 'remote-a',
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token', '': 'ignored', 'X-Count': 2 },
        },
        {
          name: 'remote-sse',
          type: 'SSE',
          url: 'https://example.com/sse',
          headers: [{ key: 'X-Api', value: 'secret' }, { name: '   ', value: 'drop' }],
        },
        {
          name: 'url-only',
          url: 'https://example.com/auto',
        },
        {
          name: 'local-stdio',
          command: 'npx',
          args: ['-y', 123],
          env: { NODE_ENV: 'production', EMPTY_IGNORE: null },
        },
        {
          name: 'minimal-stdio',
          command: 'mcp-bin',
        },
      ],
    },
  };
  const snapshot = structuredClone(original);

  for (const method of ['session/new', 'session/load', 'session/resume']) {
    const res = normalizeMcpServersMessage({ ...original, method });
    assert.deepEqual(res.params.mcpServers, [
      {
        name: 'remote-a',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer token' },
          { name: 'X-Count', value: '2' },
        ],
      },
      {
        name: 'remote-sse',
        type: 'sse',
        url: 'https://example.com/sse',
        headers: [{ name: 'X-Api', value: 'secret' }],
      },
      {
        name: 'url-only',
        type: 'http',
        url: 'https://example.com/auto',
        headers: [],
      },
      {
        name: 'local-stdio',
        command: 'npx',
        args: ['-y', '123'],
        env: [{ name: 'NODE_ENV', value: 'production' }],
      },
      {
        name: 'minimal-stdio',
        command: 'mcp-bin',
        args: [],
        env: [],
      },
    ]);
  }
  assert.deepEqual(original, snapshot, 'Original message must never be mutated');
}

// 2. Record-shaped mcpServers object is normalized to array, and non-session methods pass through unchanged
{
  const list = normalizeMcpServersList({
    paseo: {
      type: 'streamable_http',
      url: 'http://127.0.0.1:4567/mcp/agents',
      headers: { Authorization: 'Bearer abc' },
    },
  });
  assert.deepEqual(list, [
    {
      name: 'paseo',
      type: 'http',
      url: 'http://127.0.0.1:4567/mcp/agents',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }],
    },
  ]);

  const promptMsg = {
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: 's1', mcpServers: [{ name: 'x', command: 'echo' }] },
  };
  assert.equal(normalizeMcpServersMessage(promptMsg), promptMsg);
}

console.log(JSON.stringify({ passed: true, suite: 'mcp-normalize' }));
