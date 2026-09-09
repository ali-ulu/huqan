const assert = require('assert');
const { describe, test } = require('node:test');

const {
  MEMORY_RECALL_DECISIONS,
  MEMORY_RECALL_POLICY_VERSION,
  evaluateMemoryRecall,
} = require('../lib/memory-recall-gate');

const CURRENT_POLICY = '0.8.0';

function record(overrides = {}) {
  return {
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    content: { title: 'alpha' },
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    trustPolicyVersion: CURRENT_POLICY,
    provenance: {
      provenanceId: 'prov-1',
      sourceRef: 'doc://alpha',
      sourceType: 'document',
      actor: 'agent-1',
      confidence: 0.9,
    },
    ...overrides,
  };
}

function evaluate(records, opts = {}) {
  return evaluateMemoryRecall({
    workspaceId: 'workspace-a',
    records,
    currentTrustPolicyVersion: CURRENT_POLICY,
    ...opts,
  });
}

describe('memory recall gate: vocabulary', () => {
  test('exposes exactly three ordered decisions', () => {
    assert.deepStrictEqual(MEMORY_RECALL_DECISIONS, ['admit', 'degrade', 'withhold']);
  });

  test('stamps its own policy version on every result', () => {
    const result = evaluate([record()]);
    assert.strictEqual(result.policyVersion, MEMORY_RECALL_POLICY_VERSION);
  });
});

describe('memory recall gate: admission', () => {
  test('admits a current, provenanced, active record', () => {
    const result = evaluate([record()]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.summary.admitted, 1);
    assert.strictEqual(result.admitted.length, 1);
    assert.strictEqual(result.decisions[0].decision, 'admit');
  });

  test('does not mutate the records it is handed', () => {
    const input = record();
    const before = JSON.stringify(input);
    evaluate([input]);
    assert.strictEqual(JSON.stringify(input), before);
  });
});

describe('memory recall gate: stale authority', () => {
  test('degrades a record stamped with a superseded trust policy', () => {
    const result = evaluate([record({ trustPolicyVersion: '0.7.0' })]);
    assert.strictEqual(result.decisions[0].decision, 'degrade');
    assert.strictEqual(result.decisions[0].reason, 'stale_trust_policy');
    assert.strictEqual(result.summary.admitted, 0);
    assert.strictEqual(result.admitted.length, 0);
  });

  test('degrade is not rejection: the record is still reported, with its reason', () => {
    const result = evaluate([record({ trustPolicyVersion: '0.7.0' })]);
    assert.strictEqual(result.degraded.length, 1);
    assert.strictEqual(result.degraded[0].memoryId, 'mem-1');
    assert.strictEqual(result.degraded[0].recordedTrustPolicyVersion, '0.7.0');
    assert.strictEqual(result.degraded[0].currentTrustPolicyVersion, CURRENT_POLICY);
  });

  test('admits without a staleness claim when the current policy version is unknown', () => {
    const result = evaluate([record({ trustPolicyVersion: '0.7.0' })], {
      currentTrustPolicyVersion: undefined,
    });
    assert.strictEqual(result.decisions[0].decision, 'admit');
    assert.ok(result.warnings.some((w) => w.code === 'POLICY_VERSION_UNKNOWN'));
    assert.ok(!result.decisions[0].signals.some((s) => s.reason === 'stale_trust_policy'));
  });
});

describe('memory recall gate: withholding', () => {
  test('withholds a record from another workspace', () => {
    const result = evaluate([record({ workspaceId: 'workspace-b' })]);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'workspace_mismatch');
  });

  test('withholds a record with no provenance', () => {
    const result = evaluate([record({ provenance: undefined })]);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'missing_provenance');
  });

  test('withholds a non-active record', () => {
    const result = evaluate([record({ status: 'deleted' })]);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'inactive_record');
  });

  test('the strictest signal wins when several fire', () => {
    const result = evaluate([record({ status: 'deleted', trustPolicyVersion: '0.7.0' })]);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.ok(result.decisions[0].signals.some((s) => s.reason === 'stale_trust_policy'));
  });
});

describe('memory recall gate: confidence threshold', () => {
  test('is off unless a threshold is supplied', () => {
    const result = evaluate([record({ provenance: { ...record().provenance, confidence: 0.1 } })]);
    assert.strictEqual(result.decisions[0].decision, 'admit');
  });

  test('degrades a record below the supplied threshold', () => {
    const result = evaluate([record({ provenance: { ...record().provenance, confidence: 0.1 } })], {
      minConfidence: 0.5,
    });
    assert.strictEqual(result.decisions[0].decision, 'degrade');
    assert.strictEqual(result.decisions[0].reason, 'low_confidence');
  });
});

describe('memory recall gate: the ledger witnesses, the gate does not write', () => {
  test('emits a ledger event for every withheld and degraded record', () => {
    const result = evaluate([
      record({ memoryId: 'mem-ok' }),
      record({ memoryId: 'mem-stale', trustPolicyVersion: '0.7.0' }),
      record({ memoryId: 'mem-gone', status: 'deleted' }),
    ]);
    const ids = result.ledgerEvents.map((e) => e.memoryId).sort();
    assert.deepStrictEqual(ids, ['mem-gone', 'mem-stale']);
  });

  test('ledger events carry the reason, not the withheld content', () => {
    const result = evaluate([record({ status: 'deleted', content: { secret: 'do-not-hydrate' } })]);
    const event = result.ledgerEvents[0];
    assert.strictEqual(event.eventType, 'memory_recall_withheld');
    assert.strictEqual(event.reason, 'inactive_record');
    assert.ok(!JSON.stringify(event).includes('do-not-hydrate'));
  });

  test('admitted records produce no ledger noise', () => {
    const result = evaluate([record()]);
    assert.strictEqual(result.ledgerEvents.length, 0);
  });
});

describe('memory recall gate: fail-closed', () => {
  test('rejects a call with no workspace and admits nothing', () => {
    const result = evaluateMemoryRecall({ records: [record()] });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.admitted, []);
    assert.ok(result.errors.length > 0);
  });

  test('rejects a non-array records argument and admits nothing', () => {
    const result = evaluate('not-an-array');
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.admitted, []);
  });

  test('withholds an entry that is not a plain object', () => {
    const result = evaluate([null]);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'malformed_record');
  });
});
