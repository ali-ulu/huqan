'use strict';

// #4144: the knowledge-wiki fixture contract. This test pins the shape of the
// fixture set that a later read-only knowledge view will be judged against. It
// asserts data agreement only -- it exercises no runtime path, because this
// slice ships no runtime module.
//
// The properties that make the set usable as a contract, rather than a file
// that merely exists:
//
//   - every case names one of the seven declared conditions, no more;
//   - every case has exactly one expected finding, keyed by the same id;
//   - no expected finding authorizes a mutation, a canonical promotion or an
//     authoritative presentation;
//   - a hash in the fixture is marked unverified, so nothing here reads as
//     tamper evidence.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'knowledge-wiki');
const CASES = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cases.json'), 'utf8'));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));

// The scope note fixes these seven. A new case must be a deliberate contract
// change, not an accident of adding a file.
const CONDITIONS = [
  'idempotent_reingest',
  'source_drift',
  'conflict',
  'missing_provenance',
  'orphan_page',
  'lint_read_only',
  'restart_idempotency',
];

const FINDING_BY_CONDITION = {
  idempotent_reingest: 'no_duplicate',
  source_drift: 'source_drift',
  conflict: 'conflict',
  missing_provenance: 'missing_provenance',
  orphan_page: 'orphan_page',
  lint_read_only: 'read_only',
  restart_idempotency: 'identical_result',
};

test('the fixture and its expectations share one schema version and issue', () => {
  assert.equal(CASES.schemaVersion, 'huqan-knowledge-wiki-fixture-v1');
  assert.equal(EXPECTED.schemaVersion, CASES.schemaVersion);
  assert.equal(CASES.issue, 4144);
  assert.equal(EXPECTED.issue, CASES.issue);
});

test('every case names one of the seven declared conditions', () => {
  assert.equal(CASES.cases.length, CONDITIONS.length);
  for (const entry of CASES.cases) {
    assert.ok(CONDITIONS.includes(entry.condition), `unknown condition: ${entry.condition}`);
  }
  const seen = CASES.cases.map((entry) => entry.condition).sort();
  assert.deepEqual(seen, [...CONDITIONS].sort(), 'each condition appears exactly once');
});

test('every case id is unique and has exactly one expected finding', () => {
  const ids = CASES.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids must be unique');
  assert.deepEqual(Object.keys(EXPECTED.expected).sort(), [...ids].sort(),
    'expected findings must be keyed by the case ids, no more and no fewer');
  for (const entry of CASES.cases) {
    assert.equal(EXPECTED.expected[entry.id].finding, FINDING_BY_CONDITION[entry.condition],
      `${entry.id} must carry the finding its condition declares`);
  }
});

test('each case carries the inputs its condition needs', () => {
  const byId = Object.fromEntries(CASES.cases.map((entry) => [entry.id, entry]));
  assert.equal(byId['idempotent-reingest'].inputs.ingestCount, 2);
  assert.ok(byId['source-drift'].inputs.ingestedContentHash !== byId['source-drift'].inputs.rereadContentHash,
    'source drift needs the two hashes to differ');
  assert.equal(byId['conflict'].inputs.canonicalClaim.status, 'canonical');
  assert.equal(byId['conflict'].inputs.candidateClaim.status, 'candidate');
  assert.equal(byId['missing-provenance'].inputs.sourceRef, '');
  assert.equal(byId['missing-provenance'].inputs.sourceVersion, '',
    'a missing version stays missing; the fixture must not invent one');
  assert.equal(byId['orphan-page'].inputs.inboundLinks, 0);
  assert.deepEqual(byId['lint-read-only'].inputs.surfaces, ['canonicalMemory', 'graph', 'policy']);
  const versions = byId['restart-idempotency'].inputs.sourceVersions;
  assert.ok(versions.length > 1,
    'restart idempotency needs the same version seen more than once');
  assert.ok(versions.every((version) => version === versions[0]),
    'restart idempotency is a restart on the same source version');
});

test('no expected finding authorizes a mutation, a promotion or an authoritative claim', () => {
  for (const [id, entry] of Object.entries(EXPECTED.expected)) {
    assert.equal(entry.mutation, false, `${id} must not mutate`);
    assert.equal(entry.authoritative, false, `${id} must not present as authoritative`);
    if ('canonicalPromotion' in entry) {
      assert.equal(entry.canonicalPromotion, false, `${id} must not promote to canonical`);
    }
  }
  assert.equal(EXPECTED.expected.conflict.canonicalPromotion, false);
  assert.equal(EXPECTED.expected['lint-read-only'].stateChanged, false);
});

test('a fixture hash is declared unverified, never read as tamper evidence', () => {
  const reingest = CASES.cases.find((entry) => entry.id === 'idempotent-reingest');
  assert.equal(reingest.inputs.contentHashVerified, false);
  const missing = CASES.cases.find((entry) => entry.id === 'missing-provenance');
  assert.equal(missing.inputs.contentHashVerified, false);
  assert.match(CASES.note, /drift detection, not tamper evidence/);
});

test('the fixture names no store and no write path', () => {
  assert.match(CASES.note, /no store and no write path/);
  const serialized = JSON.stringify(CASES) + JSON.stringify(EXPECTED);
  for (const forbidden of ['"store"', 'writePath', 'canonicalStore', 'memoryStorePath']) {
    assert.ok(!serialized.includes(forbidden), `fixture must not introduce ${forbidden}`);
  }
});
