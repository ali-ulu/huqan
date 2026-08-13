'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');

function makePrevention() {
  const memory = new MemoryStore({ useSQLite: false });
  return { memory, prevention: createErrorPrevention(memory) };
}

test('circular evidence fails closed as INVALID_EVIDENCE without a memory write', () => {
  const { memory, prevention } = makePrevention();
  const item = { type: 'test' };
  item.self = item;

  const result = prevention.recordFailure({
    source: 'test_failure',
    operation: 'write',
    observed: 'failed',
    evidence: [item],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_EVIDENCE');
  assert.equal(memory.list({ workspaceId: 'default' }).total, 0);
});

test('non-array evidence is rejected instead of silently discarded', () => {
  const { memory, prevention } = makePrevention();
  const result = prevention.recordFailure({
    source: 'test_failure',
    operation: 'write',
    observed: 'failed',
    evidence: { type: 'test', ref: 'not-an-array' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_EVIDENCE');
  assert.equal(memory.list({ workspaceId: 'default' }).total, 0);
});
