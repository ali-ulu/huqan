'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { normalizeWorkspaceId, WORKSPACE_ID_INVALID } = require('../lib/workspace-id');
const { normalizeWorkspaceId: normalizeGraphWorkspaceId } = require('../lib/graph-record-utils');
const { normalizeWorkspaceId: normalizeMemoryWorkspaceId } = require('../lib/memory-store-utils');
const { normalizeWorkspaceId: normalizeCliWorkspaceId } = require('../lib/cli-mutation-audit-intent');
const { normalizeWorkspaceId: normalizeVerifyWorkspaceId } = require('../lib/verify-native');

test('workspace normalization is shared across graph, memory, CLI, and verification', () => {
  for (const normalizer of [
    normalizeWorkspaceId,
    normalizeGraphWorkspaceId,
    normalizeMemoryWorkspaceId,
    normalizeCliWorkspaceId,
    normalizeVerifyWorkspaceId,
  ]) {
    assert.equal(normalizer(' workspace-a '), 'workspace-a');
    assert.equal(normalizer(null), 'default');
    assert.equal(normalizer('   '), 'default');
  }
});

test('supplied non-string workspace identifiers fail closed instead of changing scope', () => {
  for (const value of [42, true, ['a', 'b'], { workspace: 'a' }]) {
    assert.throws(
      () => normalizeWorkspaceId(value),
      (error) => error?.code === WORKSPACE_ID_INVALID,
    );
  }
  assert.equal(normalizeWorkspaceId('a'.repeat(128)), 'a'.repeat(128));
  assert.throws(
    () => normalizeWorkspaceId('a'.repeat(129)),
    (error) => error?.code === WORKSPACE_ID_INVALID,
  );
});

test('Graph rejects a numeric workspace instead of writing it into default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-workspace-id-'));
  try {
    const graph = new Graph({ memoryPath: path.join(dir, 'memory.json'), useSQLite: false });
    assert.throws(
      () => graph.addNode('secret', 'Tenant 42 data', null, { workspaceId: 42 }),
      (error) => error?.code === WORKSPACE_ID_INVALID,
    );
    assert.equal(graph.getNode('secret', {}), null);
    assert.deepEqual(graph.getNodes({ workspaceId: 'default' }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
