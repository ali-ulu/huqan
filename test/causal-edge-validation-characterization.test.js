'use strict';

// #2401: validateCausalEdge is characterized before it becomes a rule table.
// Every case's full result -- error codes, messages, fields and their order --
// is compared with test/fixtures/causal-edge-validation.golden.json.
// Regenerate only for an intended behavior change:
//   HUQAN_UPDATE_GOLDEN=1 node --test test/causal-edge-validation-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateCausalEdge, CAUSAL_FUTURE_FIELDS } = require('../lib/causal/causal-edge');

const GOLDEN = path.join(__dirname, 'fixtures', 'causal-edge-validation.golden.json');

const BASE = Object.freeze({
  id: 'edge-1',
  from: 'rain',
  to: 'flood',
  relation: 'CAUSES',
  strength: 0.6,
  workspaceId: 'ws',
  provenanceId: 'prov_1',
  trustPolicyVersion: 'tp-1',
  createdAt: '2026-01-01T00:00:00Z',
  edgeSchemaVersion: '1.0.0',
});

const VARIANTS = {
  id: ['', '   ', 7, null],
  from: ['', 3, null],
  to: ['', {}, null],
  relation: ['LIKES', '', null, 'causes'],
  strength: [-0.1, 1.1, Number.NaN, Infinity, '0.5', null, 0, 1, 0.25, 0.5, 0.75],
  confidence: [0.5, -1, 2, Number.NaN, '0.3', null],
  workspaceId: ['', '  ', 5],
  provenanceId: ['', ' prov', 'prov ', '   ', 9],
  trustPolicyVersion: ['', null, 1],
  createdAt: ['2026-01-01', 'not a date', '2026-13-40T00:00:00Z', '2026-01-01T00:00:00.123+03:00', 12],
  edgeSchemaVersion: ['2.0.0', '', 1],
  strengthLabel: [null, 'strong', 'weak', 'nope'],
};

function cases() {
  const out = [
    { name: 'valid', input: { ...BASE } },
    { name: 'null', input: null },
    { name: 'array', input: [] },
    { name: 'string', input: 'edge' },
    { name: 'empty-object', input: {} },
    { name: 'self-edge', input: { ...BASE, to: 'rain' } },
    { name: 'self-edge-blank', input: { ...BASE, from: '', to: '' } },
  ];
  for (const [field, values] of Object.entries(VARIANTS)) {
    values.forEach((value, index) => out.push({ name: `${field}#${index}`, input: { ...BASE, [field]: value } }));
  }
  for (const field of Object.keys(BASE)) {
    const { [field]: _dropped, ...rest } = BASE;
    out.push({ name: `missing:${field}`, input: rest });
  }
  for (const field of CAUSAL_FUTURE_FIELDS) {
    out.push({ name: `future:${field}:null`, input: { ...BASE, [field]: null } });
    out.push({ name: `future:${field}:set`, input: { ...BASE, [field]: { x: 1 } } });
  }
  out.push({
    name: 'everything-wrong',
    input: {
      id: '', from: 'a', to: 'a', relation: 'NOPE', strength: 5, confidence: -1, workspaceId: '',
      provenanceId: ' p', trustPolicyVersion: '', createdAt: 'x', edgeSchemaVersion: '9', temporal: 1,
      probability: 'p', strengthLabel: 'weak',
    },
  });
  out.push({ name: 'label-mismatch-with-other-errors', input: { ...BASE, id: '', strengthLabel: 'weak', formalProof: false } });
  return out;
}

function run() {
  return Object.fromEntries(cases().map(({ name, input }) => [name, validateCausalEdge(input)]));
}

test('validateCausalEdge matches its recorded result for every characterized input', () => {
  const actual = JSON.parse(JSON.stringify(run()));
  if (process.env.HUQAN_UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden), 'the case list and the fixture must match');
  for (const name of Object.keys(golden)) assert.deepEqual(actual[name], golden[name], name);
});

test('the characterized inputs reach every error code', () => {
  const { CAUSAL_EDGE_ERROR_CODES } = require('../lib/causal/causal-edge-errors');
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const seen = new Set(Object.values(golden).flatMap((row) => row.errors.map((error) => error.code)));
  const unreached = Object.values(CAUSAL_EDGE_ERROR_CODES).filter((code) => !seen.has(code));
  assert.deepEqual(unreached, []);
});
