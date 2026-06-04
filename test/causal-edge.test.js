'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CAUSAL_EDGE_RELATIONS,
  CAUSAL_STRENGTH_BANDS,
  CAUSAL_EDGE_SCHEMA_VERSION,
  CAUSAL_FUTURE_FIELDS,
  strengthToLabel,
  labelToBand,
  bandForStrength,
  isNonEmptyString,
  isStableId,
  isIso8601,
  validateCausalEdge,
  normalizeCausalEdge,
  createCausalEdge,
} = require('../lib/causal/causal-edge');
const { CAUSAL_EDGE_ERROR_CODES, CausalEdgeValidationError } = require('../lib/causal/causal-edge-errors');

function validEdge(overrides = {}) {
  return {
    id: 'edge-1',
    from: 'node-a',
    to: 'node-b',
    relation: 'CAUSES',
    strength: 0.8,
    workspaceId: 'default',
    provenanceId: 'prov_test1234',
    trustPolicyVersion: '1.0.0',
    createdAt: '2026-06-05T10:00:00.000Z',
    edgeSchemaVersion: '1.0.0',
    ...overrides,
  };
}

describe('causal-edge helpers', () => {
  it('strengthToLabel returns correct bands', () => {
    assert.strictEqual(strengthToLabel(0), 'weak');
    assert.strictEqual(strengthToLabel(0.1), 'weak');
    assert.strictEqual(strengthToLabel(0.24), 'weak');
    assert.strictEqual(strengthToLabel(0.25), 'medium');
    assert.strictEqual(strengthToLabel(0.4), 'medium');
    assert.strictEqual(strengthToLabel(0.49), 'medium');
    assert.strictEqual(strengthToLabel(0.5), 'strong');
    assert.strictEqual(strengthToLabel(0.6), 'strong');
    assert.strictEqual(strengthToLabel(0.74), 'strong');
    assert.strictEqual(strengthToLabel(0.75), 'very_strong');
    assert.strictEqual(strengthToLabel(0.9), 'very_strong');
    assert.strictEqual(strengthToLabel(1), 'very_strong');
  });

  it('strengthToLabel returns null for out-of-range or non-finite', () => {
    assert.strictEqual(strengthToLabel(-0.1), null);
    assert.strictEqual(strengthToLabel(1.1), null);
    assert.strictEqual(strengthToLabel(NaN), null);
    assert.strictEqual(strengthToLabel(Infinity), null);
    assert.strictEqual(strengthToLabel('0.5'), null);
    assert.strictEqual(strengthToLabel(null), null);
    assert.strictEqual(strengthToLabel(undefined), null);
  });

  it('labelToBand returns correct band', () => {
    const weak = labelToBand('weak');
    assert.strictEqual(weak.id, 'weak');
    assert.strictEqual(weak.min, 0);
    assert.strictEqual(weak.max, 0.25);

    const veryStrong = labelToBand('very_strong');
    assert.strictEqual(veryStrong.id, 'very_strong');
    assert.strictEqual(veryStrong.min, 0.75);
    assert.strictEqual(veryStrong.max, 1.01);
  });

  it('labelToBand returns null for invalid label', () => {
    assert.strictEqual(labelToBand('invalid'), null);
    assert.strictEqual(labelToBand(''), null);
    assert.strictEqual(labelToBand(null), null);
    assert.strictEqual(labelToBand(123), null);
  });

  it('bandForStrength returns correct band', () => {
    const band = bandForStrength(0.6);
    assert.strictEqual(band.id, 'strong');
  });

  it('isNonEmptyString works correctly', () => {
    assert.strictEqual(isNonEmptyString('hello'), true);
    assert.strictEqual(isNonEmptyString('  '), false);
    assert.strictEqual(isNonEmptyString(''), false);
    assert.strictEqual(isNonEmptyString(null), false);
    assert.strictEqual(isNonEmptyString(123), false);
    assert.strictEqual(isNonEmptyString(undefined), false);
  });

  it('isStableId works correctly', () => {
    assert.strictEqual(isStableId('prov_abc'), true);
    assert.strictEqual(isStableId(' prov_abc '), false);
    assert.strictEqual(isStableId(''), false);
    assert.strictEqual(isStableId(null), false);
  });

  it('isIso8601 validates correctly', () => {
    assert.strictEqual(isIso8601('2026-06-05T10:00:00.000Z'), true);
    assert.strictEqual(isIso8601('2026-06-05T10:00:00+02:00'), true);
    assert.strictEqual(isIso8601('2026-06-05T10:00:00.123Z'), true);
    assert.strictEqual(isIso8601('not-a-date'), false);
    assert.strictEqual(isIso8601(''), false);
    assert.strictEqual(isIso8601(null), false);
    assert.strictEqual(isIso8601(undefined), false);
  });
});

describe('validateCausalEdge happy path', () => {
  const relations = ['CAUSES', 'PREVENTS', 'ENABLES', 'DEPENDS_ON', 'LEADS_TO'];
  const bands = [
    { strength: 0, label: 'weak' },
    { strength: 0.25, label: 'medium' },
    { strength: 0.5, label: 'strong' },
    { strength: 0.75, label: 'very_strong' },
  ];

  for (const relation of relations) {
    for (const band of bands) {
      it(`valid edge: ${relation} + strength ${band.strength} (${band.label})`, () => {
        const edge = validEdge({ relation, strength: band.strength });
        const result = validateCausalEdge(edge);
        assert.strictEqual(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
        assert.strictEqual(result.errors.length, 0);
      });
    }
  }
});

describe('validateCausalEdge negative cases', () => {
  it('rejects non-object input', () => {
    const result = validateCausalEdge(null);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.strictEqual(result.errors[0].code, CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD);
  });

  it('rejects array input', () => {
    const result = validateCausalEdge([]);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD));
  });

  it('rejects missing id', () => {
    const edge = validEdge();
    delete edge.id;
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.field === 'id' && e.code === CAUSAL_EDGE_ERROR_CODES.MISSING_FIELD));
  });

  it('rejects missing relation', () => {
    const edge = validEdge();
    delete edge.relation;
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.field === 'relation'));
  });

  it('rejects missing strength', () => {
    const edge = validEdge();
    delete edge.strength;
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.field === 'strength'));
  });

  it('rejects self-edge (from === to)', () => {
    const edge = validEdge({ to: 'node-a' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.SELF_EDGE));
  });

  it('rejects invalid relation', () => {
    const edge = validEdge({ relation: 'LOVES' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_RELATION));
  });

  it('rejects strength < 0', () => {
    const edge = validEdge({ strength: -0.1 });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH));
  });

  it('rejects strength > 1', () => {
    const edge = validEdge({ strength: 1.1 });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH));
  });

  it('rejects strength NaN', () => {
    const edge = validEdge({ strength: NaN });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_STRENGTH));
  });

  it('rejects empty workspaceId', () => {
    const edge = validEdge({ workspaceId: '' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_WORKSPACE_ID));
  });

  it('rejects empty provenanceId', () => {
    const edge = validEdge({ provenanceId: '' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.EMPTY_PROVENANCE_ID));
  });

  it('rejects whitespace-padded provenanceId', () => {
    const edge = validEdge({ provenanceId: ' prov_abc ' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_PROVENANCE_ID));
  });

  it('rejects empty trustPolicyVersion', () => {
    const edge = validEdge({ trustPolicyVersion: '' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.MISSING_TRUST_POLICY_VERSION));
  });

  it('rejects invalid createdAt timestamp', () => {
    const edge = validEdge({ createdAt: 'not-a-date' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_TIMESTAMP));
  });

  it('rejects wrong edgeSchemaVersion', () => {
    const edge = validEdge({ edgeSchemaVersion: '2.0.0' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.INVALID_EDGE_SCHEMA_VERSION));
  });

  it('rejects non-null future field', () => {
    const edge = validEdge({ temporal: { ts: 123 } });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.code === CAUSAL_EDGE_ERROR_CODES.FUTURE_FIELD_NOT_NULL && e.field === 'temporal'));
  });

  it('reports multiple errors at once', () => {
    const edge = { id: 'e1' };
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length >= 3);
  });
});

describe('validateCausalEdge strengthLabel warning', () => {
  it('warns when strengthLabel does not match band', () => {
    const edge = validEdge({ strengthLabel: 'weak' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, true);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.code === CAUSAL_EDGE_ERROR_CODES.STRENGTH_LABEL_MISMATCH));
  });

  it('no warning when strengthLabel matches band', () => {
    const edge = validEdge({ strengthLabel: 'very_strong' });
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('no warning when strengthLabel is absent', () => {
    const edge = validEdge();
    const result = validateCausalEdge(edge);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.warnings.length, 0);
  });
});

describe('normalizeCausalEdge', () => {
  it('returns frozen normalized edge with future fields as null', () => {
    const edge = validEdge();
    const normalized = normalizeCausalEdge(edge);
    assert.ok(Object.isFrozen(normalized));
    assert.strictEqual(normalized.edgeSchemaVersion, '1.0.0');
    assert.strictEqual(normalized.temporal, null);
    assert.strictEqual(normalized.probability, null);
    assert.strictEqual(normalized.formalProof, null);
    assert.strictEqual(normalized.worldModel, null);
    assert.strictEqual(normalized.causalProjection, null);
    assert.strictEqual(normalized.counterfactualTrace, null);
    assert.strictEqual(normalized.simulationReceipt, null);
  });

  it('preserves optional fields when present', () => {
    const edge = validEdge({ strengthLabel: 'very_strong', confidence: 0.9, metadata: { note: 'test' } });
    const normalized = normalizeCausalEdge(edge);
    assert.strictEqual(normalized.strengthLabel, 'very_strong');
    assert.strictEqual(normalized.confidence, 0.9);
    assert.deepStrictEqual(normalized.metadata, { note: 'test' });
  });

  it('omits optional fields when absent', () => {
    const edge = validEdge();
    const normalized = normalizeCausalEdge(edge);
    assert.strictEqual('strengthLabel' in normalized, false);
    assert.strictEqual('confidence' in normalized, false);
    assert.strictEqual('metadata' in normalized, false);
  });

  it('adds missing future fields as null', () => {
    const edge = validEdge();
    delete edge.temporal;
    delete edge.simulationReceipt;
    const normalized = normalizeCausalEdge(edge);
    assert.strictEqual(normalized.temporal, null);
    assert.strictEqual(normalized.simulationReceipt, null);
  });

  it('accepts null future field', () => {
    const edge = validEdge({ temporal: null });
    const normalized = normalizeCausalEdge(edge);
    assert.strictEqual(normalized.temporal, null);
  });

  it('rejects non-null future field via CausalEdgeValidationError', () => {
    const edge = validEdge({ probability: 0.5 });
    assert.throws(() => normalizeCausalEdge(edge), CausalEdgeValidationError);
  });
});

describe('createCausalEdge', () => {
  it('returns frozen edge', () => {
    const edge = createCausalEdge(validEdge());
    assert.ok(Object.isFrozen(edge));
    assert.strictEqual(edge.id, 'edge-1');
    assert.strictEqual(edge.edgeSchemaVersion, '1.0.0');
  });

  it('all future fields are null', () => {
    const edge = createCausalEdge(validEdge());
    for (const field of CAUSAL_FUTURE_FIELDS) {
      assert.strictEqual(edge[field], null, `${field} must be null`);
    }
  });

  it('throws on invalid input', () => {
    assert.throws(() => createCausalEdge({}), CausalEdgeValidationError);
  });

  it('throws on non-null future field', () => {
    assert.throws(() => createCausalEdge(validEdge({ temporal: { bad: true } })), CausalEdgeValidationError);
  });
});
