'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  BYPASS_KINDS,
  DEFAULT_WINDOW_MS,
  recordBypassSignal,
  readBypassState,
} = require('../lib/bypass-signal-state');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bypass-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

test('repeated fingerprints count per agent inside the window', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: DIGEST_A, receiptRef: 'receipt-1', at: iso(BASE),
  });
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: DIGEST_A, at: iso(BASE + HOUR),
  });
  recordBypassSignal(graph, {
    kind: 'sandbox-escape', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: DIGEST_B, at: iso(BASE + HOUR),
  });
  const state = readBypassState(graph, { workspaceId: 'workspace-a', agentId: 'agent-1', at: iso(BASE + 2 * HOUR) });
  assert.equal(state.total, 3);
  assert.equal(state.byFingerprint[DIGEST_A].count, 2);
  assert.deepEqual(state.byFingerprint[DIGEST_A].kinds, ['refused-retry']);
  assert.equal(state.byFingerprint[DIGEST_B].count, 1);
  assert.deepEqual(BYPASS_KINDS, ['refused-retry', 'sandbox-escape', 'identity-widening', 'unexpected-egress']);
});

test('other agents, workspaces, kinds and old rows stay out', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: DIGEST_A, at: iso(BASE),
  });
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-a', agentId: 'agent-2',
    fingerprint: DIGEST_A, at: iso(BASE),
  });
  recordBypassSignal(graph, {
    kind: 'refused-retry', workspaceId: 'workspace-b', agentId: 'agent-1',
    fingerprint: DIGEST_A, at: iso(BASE),
  });
  assert.equal(readBypassState(graph, { workspaceId: 'workspace-a', agentId: 'agent-1', at: iso(BASE) }).total, 1);
  assert.equal(readBypassState(graph, { workspaceId: 'workspace-a', agentId: 'agent-1', kind: 'sandbox-escape', at: iso(BASE) }).total, 0);
  assert.equal(readBypassState(graph, { workspaceId: 'workspace-a', at: iso(BASE + DEFAULT_WINDOW_MS + HOUR) }).total, 0);
});

test('missing identity is unattributed, never clean and never assigned', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordBypassSignal(graph, {
    kind: 'unexpected-egress', workspaceId: 'workspace-a', fingerprint: DIGEST_A, at: iso(BASE),
  });
  const scoped = readBypassState(graph, { workspaceId: 'workspace-a', agentId: 'agent-1', at: iso(BASE) });
  assert.equal(scoped.total, 0, 'unattributed rows pollute no agent count');
  const workspace = readBypassState(graph, { workspaceId: 'workspace-a', at: iso(BASE) });
  assert.equal(workspace.total, 1, 'the workspace total keeps unattributed rows visible');
});

test('state survives reopening and malformed calls fail closed', (t) => {
  const dir = tempDir(t);
  recordBypassSignal(memoryGraph(dir), {
    kind: 'identity-widening', workspaceId: 'workspace-a', agentId: 'agent-1',
    fingerprint: DIGEST_A, at: iso(BASE),
  });
  const state = readBypassState(memoryGraph(dir), { workspaceId: 'workspace-a', agentId: 'agent-1', at: iso(BASE + HOUR) });
  assert.equal(state.total, 1);

  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordBypassSignal(graph, { kind: 'nope', workspaceId: 'w', fingerprint: DIGEST_A }), /kind/);
  assert.throws(() => recordBypassSignal(graph, { kind: 'refused-retry', workspaceId: 'w', fingerprint: 'raw arguments here' }), /hex digest/);
  assert.throws(() => recordBypassSignal(graph, { kind: 'refused-retry', workspaceId: 'w', fingerprint: DIGEST_A, at: 'yesterday' }), /valid instant/);
  assert.throws(() => readBypassState(graph, { workspaceId: 'w', windowMs: 0 }), /windowMs/);
  assert.equal(readBypassState(graph, { workspaceId: 'w', at: iso(BASE) }).total, 0);
});
