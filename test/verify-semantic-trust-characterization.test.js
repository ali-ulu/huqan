'use strict';

// #2401: buildVerifySemanticTrust is characterized, input by input, before it
// is decomposed. Every case below is run through the function and compared with
// the recorded output in test/fixtures/verify-semantic-trust.golden.json -- the
// whole object, signal order included, not a few chosen fields. Regenerate the
// fixture only for an intended behavior change:
//   HUQAN_UPDATE_GOLDEN=1 node --test test/verify-semantic-trust-characterization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildVerifySemanticTrust } = require('../lib/verify-native');

const GOLDEN = path.join(__dirname, 'fixtures', 'verify-semantic-trust.golden.json');

// Each statement trips one risk detector (checked by the second test); `all`
// trips every one of them, which is what pins the order signals are emitted in.
const STATEMENTS = {
  plain: 'kahve uyarıcıdır',
  highRisk: 'aspirin kanser tedavi eder',
  absolute: 'kahve asla zararlı olmaz',
  doubleNegation: 'it is not not true',
  weasel: 'coffee might probably be healthy',
  strawman: 'he said that coffee is poison',
  alias: 'react-native is node.js',
  multilingual: 'kahve nedir',
  all: 'he said that aspirin never cures kanser, it is not not true, probably, react-native nedir',
};

const EVIDENCE = {
  none: [],
  partial: [{ kind: 'partial_match', text: 'kahve ~ uyarıcı' }],
  path: [{ kind: 'path', text: 'kahve -> kafein -> uyarıcı' }],
  direct: [{ kind: 'direct_edge', text: 'kahve uyarıcıdır' }],
};

const RESULTS = {
  verifiedHigh: { status: 'verified', confidence: 0.9 },
  verifiedLow: { status: 'verified', confidence: 0.3 },
  verifiedNoConfidence: { status: 'verified' },
  contradicted: { status: 'contradicted', confidence: 0.8 },
  unknown: { status: 'unknown', confidence: 0.2 },
  odd: { status: 'bogus', confidence: 0.5 },
};

const EDGES = {
  none: [],
  conflicting: [{ from: 'kahve', relation: 'sakinleştirir', to: 'sinir' }],
  opposite: [{ from: 'kahve', relation: 'IS_NOT', to: 'uyarıcı' }],
};

function cases() {
  const out = [];
  for (const [resultName, result] of Object.entries(RESULTS)) {
    for (const [evidenceName, evidence] of Object.entries(EVIDENCE)) {
      out.push({ name: `${resultName}/${evidenceName}/plain/none`, input: { statement: STATEMENTS.plain, result, evidence, subject: 'kahve', predicate: 'uyarıcı' } });
    }
    for (const [statementName, statement] of Object.entries(STATEMENTS)) {
      out.push({ name: `${resultName}/direct/${statementName}/none`, input: { statement, result, evidence: EVIDENCE.direct, subject: 'kahve', predicate: 'uyarıcı' } });
    }
    for (const [edgeName, edges] of Object.entries(EDGES)) {
      out.push({ name: `${resultName}/none/plain/${edgeName}`, input: { statement: STATEMENTS.plain, result, evidence: [], subject: 'kahve', predicate: 'uyarıcı', edges } });
    }
  }
  out.push({
    name: 'unknown/typeConflict+seed',
    input: {
      statement: STATEMENTS.plain,
      result: RESULTS.unknown,
      evidence: [],
      typeConflict: { rule: 'TYPE_LATTICE', kind: 'contradiction', severity: 0.8, flags: ['TYPE_CONFLICT'] },
      contradictionSignals: [{ rule: 'SEED', kind: 'contradiction', confidence: 0.4, flags: ['SEED'] }],
      workspaceId: 'ws-1',
      pathSearch: { depth: 2 },
      fuzzy: { overlap: 0.5 },
    },
  });
  // Edges that do trip the contradiction rules, so the per-edge routing into
  // contradiction vs risk signals is characterized, not only the empty path.
  const ruleEdges = [
    { name: 'count-conflict', statement: 'B737 has 4 engines', subject: 'B737', predicate: 'has', edges: [{ from: 'B737', relation: 'has', to: '2 engines' }] },
    { name: 'cause-prevent', statement: 'engine prevents failure', subject: 'engine', predicate: 'prevents', edges: [{ from: 'engine', relation: 'causes', to: 'failure' }] },
    { name: 'two-edges', statement: 'B737 has 4 engines', subject: 'B737', predicate: 'has', edges: [{ from: 'B737', relation: 'has', to: '2 engines' }, { from: 'B737', relation: 'causes', to: 'noise' }] },
  ];
  for (const edgeCase of ruleEdges) {
    for (const resultName of ['unknown', 'verifiedHigh', 'contradicted']) {
      out.push({ name: `${resultName}/rule-edge/${edgeCase.name}`, input: { ...edgeCase, name: undefined, result: RESULTS[resultName], evidence: [] } });
    }
  }
  out.push({ name: 'defaults', input: {} });
  return out;
}

test('buildVerifySemanticTrust matches its recorded output for every characterized input', () => {
  const actual = Object.fromEntries(cases().map(({ name, input }) => [name, buildVerifySemanticTrust(input)]));
  const serialized = JSON.parse(JSON.stringify(actual));
  if (process.env.HUQAN_UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(serialized, null, 2)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(serialized), Object.keys(golden), 'the case list and the fixture must match');
  for (const name of Object.keys(golden)) {
    assert.deepEqual(serialized[name], golden[name], name);
  }
});

test('the characterized inputs exercise every branch the decomposition must keep', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const statuses = new Set(Object.values(golden).map((row) => row.status));
  const matchTypes = new Set(Object.values(golden).map((row) => row.matchType));
  const flags = new Set(Object.values(golden).flatMap((row) => row.warnings || []));
  for (const status of ['verified', 'contradicted', 'unknown']) assert.ok(statuses.has(status), `status ${status}`);
  for (const type of ['partial_match', 'path', 'direct_edge', 'contradiction', 'unknown']) assert.ok(matchTypes.has(type), `matchType ${type}`);
  for (const flag of ['HIGH_RISK_DOMAIN', 'ABSOLUTE_CLAIM', 'DOUBLE_NEGATION', 'WEASEL_WORDS', 'STRAWMAN_ATTRIBUTION', 'ALIAS_NORMALIZATION', 'MULTILINGUAL_AMBIGUITY', 'WEAK_PARTIAL_MATCH', 'VERIFY_CONTRADICTION']) {
    assert.ok(flags.has(flag), `risk flag ${flag} is exercised`);
  }
});
