'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toObservationEvent } = require('./examples/mcp-observation-client');

describe('mcp ecosystem entry', () => {
  it('maps an MCP tool call to a content-free observation envelope', () => {
    const event = toObservationEvent({
      agentId: 'mcp-agent',
      runId: 'run-mcp-1',
      stepId: 'step-1',
      toolName: 'shell',
      kind: 'shell',
    });
    assert.strictEqual(event.schemaVersion, 'huqan.external-event.v1');
    assert.strictEqual(event.action, 'tool.requested');
    assert.strictEqual(event.target, 'shell:shell');
    assert.match(event.input_hash, /^[0-9a-f]{64}$/);
    assert.strictEqual(event.decision, 'unknown');
    assert.strictEqual(event.receipt_id, null);
  });

  it('requires identity fields (fail-closed)', () => {
    assert.throws(() => toObservationEvent({}), /required/);
  });
});
