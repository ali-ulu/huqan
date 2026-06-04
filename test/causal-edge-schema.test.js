'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CAUSAL_EDGE_RELATIONS,
  CAUSAL_STRENGTH_BANDS,
  CAUSAL_EDGE_SCHEMA_VERSION,
  CAUSAL_FUTURE_FIELDS,
  REQUIRED_FIELDS,
  strengthToLabel,
  labelToBand,
  bandForStrength,
} = require('../lib/causal/causal-edge');
const { CAUSAL_EDGE_ERROR_CODES } = require('../lib/causal/causal-edge-errors');
const { CAUSAL_RELATIONS } = require('../graph');

describe('frozen exports', () => {
  it('CAUSAL_EDGE_RELATIONS is frozen', () => {
    assert.ok(Object.isFrozen(CAUSAL_EDGE_RELATIONS));
  });

  it('CAUSAL_STRENGTH_BANDS is frozen with 4 bands', () => {
    assert.ok(Object.isFrozen(CAUSAL_STRENGTH_BANDS));
    assert.strictEqual(CAUSAL_STRENGTH_BANDS.length, 4);
    const ids = CAUSAL_STRENGTH_BANDS.map(b => b.id);
    assert.deepStrictEqual(ids, ['weak', 'medium', 'strong', 'very_strong']);
    for (const band of CAUSAL_STRENGTH_BANDS) {
      assert.ok(Object.isFrozen(band));
    }
  });

  it('CAUSAL_EDGE_SCHEMA_VERSION is "1.0.0"', () => {
    assert.strictEqual(CAUSAL_EDGE_SCHEMA_VERSION, '1.0.0');
  });

  it('CAUSAL_FUTURE_FIELDS is frozen with 7 entries', () => {
    assert.ok(Object.isFrozen(CAUSAL_FUTURE_FIELDS));
    assert.strictEqual(CAUSAL_FUTURE_FIELDS.length, 7);
    assert.deepStrictEqual([...CAUSAL_FUTURE_FIELDS], [
      'temporal',
      'probability',
      'formalProof',
      'worldModel',
      'causalProjection',
      'counterfactualTrace',
      'simulationReceipt',
    ]);
  });

  it('REQUIRED_FIELDS is frozen with 10 entries', () => {
    assert.ok(Object.isFrozen(REQUIRED_FIELDS));
    assert.strictEqual(REQUIRED_FIELDS.length, 10);
  });

  it('CAUSAL_EDGE_ERROR_CODES is frozen with 12 entries', () => {
    assert.ok(Object.isFrozen(CAUSAL_EDGE_ERROR_CODES));
    assert.strictEqual(Object.keys(CAUSAL_EDGE_ERROR_CODES).length, 12);
  });
});

describe('CAUSAL_EDGE_RELATIONS matches graph.js CAUSAL_RELATIONS', () => {
  it('CAUSAL_EDGE_RELATIONS is a copy of CAUSAL_RELATIONS', () => {
    assert.strictEqual(CAUSAL_EDGE_RELATIONS.length, CAUSAL_RELATIONS.length);
    for (let i = 0; i < CAUSAL_RELATIONS.length; i++) {
      assert.strictEqual(CAUSAL_EDGE_RELATIONS[i], CAUSAL_RELATIONS[i]);
    }
  });

  it('CAUSAL_EDGE_RELATIONS are UPPERCASE', () => {
    for (const rel of CAUSAL_EDGE_RELATIONS) {
      assert.strictEqual(rel, rel.toUpperCase(), `'${rel}' is not UPPERCASE`);
    }
  });

  it('CAUSAL_EDGE_RELATIONS has no duplicates', () => {
    const unique = new Set(CAUSAL_EDGE_RELATIONS);
    assert.strictEqual(unique.size, CAUSAL_EDGE_RELATIONS.length);
  });
});

describe('CAUSAL_STRENGTH_BANDS continuity', () => {
  it('bands cover [0, 1] with no gaps', () => {
    const sorted = [...CAUSAL_STRENGTH_BANDS].sort((a, b) => a.min - b.min);
    assert.strictEqual(sorted[0].min, 0);
    for (let i = 0; i < sorted.length - 1; i++) {
      assert.strictEqual(sorted[i].max, sorted[i + 1].min, `gap between ${sorted[i].id} and ${sorted[i + 1].id}`);
    }
    assert.ok(sorted[sorted.length - 1].max > 1);
  });

  it('band IDs are unique', () => {
    const ids = CAUSAL_STRENGTH_BANDS.map(b => b.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
});

describe('determinism (multiverse-safe)', () => {
  it('strengthToLabel is deterministic for same input', () => {
    const inputs = [0, 0.1, 0.25, 0.5, 0.75, 1, 0.3333333];
    for (const input of inputs) {
      const first = strengthToLabel(input);
      const second = strengthToLabel(input);
      assert.strictEqual(first, second, `strengthToLabel(${input}) returned different results`);
    }
  });

  it('labelToBand is deterministic for same input', () => {
    const labels = ['weak', 'medium', 'strong', 'very_strong', 'invalid'];
    for (const label of labels) {
      const first = JSON.stringify(labelToBand(label));
      const second = JSON.stringify(labelToBand(label));
      assert.strictEqual(first, second, `labelToBand('${label}') returned different results`);
    }
  });

  it('bandForStrength is deterministic for same input', () => {
    const inputs = [0, 0.3, 0.6, 0.9, 1];
    for (const input of inputs) {
      const first = JSON.stringify(bandForStrength(input));
      const second = JSON.stringify(bandForStrength(input));
      assert.strictEqual(first, second, `bandForStrength(${input}) returned different results`);
    }
  });
});

describe('error code names', () => {
  it('all 12 error codes exist as keys', () => {
    const expected = [
      'MISSING_FIELD',
      'INVALID_RELATION',
      'INVALID_STRENGTH',
      'INVALID_WORKSPACE_ID',
      'EMPTY_PROVENANCE_ID',
      'INVALID_PROVENANCE_ID',
      'FUTURE_FIELD_NOT_NULL',
      'MISSING_TRUST_POLICY_VERSION',
      'INVALID_TIMESTAMP',
      'INVALID_EDGE_SCHEMA_VERSION',
      'STRENGTH_LABEL_MISMATCH',
      'SELF_EDGE',
    ];
    for (const name of expected) {
      assert.ok(name in CAUSAL_EDGE_ERROR_CODES, `${name} missing from CAUSAL_EDGE_ERROR_CODES`);
      assert.strictEqual(CAUSAL_EDGE_ERROR_CODES[name], name);
    }
  });
});
