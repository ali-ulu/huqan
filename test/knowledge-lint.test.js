'use strict';

// #4144 slice 2: the read-only knowledge lint. This test consumes the
// `lint-read-only` fixture declared in the scope PR (test/fixtures/knowledge-wiki)
// and supplies the proof that fixture deferred -- that lint reads a state and
// leaves it unchanged -- plus the findings the other fixture conditions expect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  KNOWLEDGE_LINT_SCHEMA_VERSION,
  LINT_CODES,
  LINT_SURFACES,
  stateDigest,
  lintKnowledgeState,
} = require('../lib/knowledge-lint');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'knowledge-wiki');
const cases = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cases.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected.json'), 'utf8'));

const caseById = new Map(cases.cases.map((entry) => [entry.id, entry]));
const inputsOf = (id) => caseById.get(id).inputs;
const expectedOf = (id) => expected.expected[id];

function codes(report) {
  return report.findings.map((item) => item.code);
}

/**
 * Build a lint state from a fixture case. Each builder uses only the inputs the
 * case declares, so the fixture drives the test rather than restating it.
 */
const stateFor = {
  'source-drift': (input) => ({
    workspaceId: 'fixture',
    sources: [{
      sourceRef: input.sourceRef,
      sourceVersion: input.ingestedVersion,
      contentHash: input.ingestedContentHash,
      currentContentHash: input.rereadContentHash,
    }],
    claims: [{ claimId: 'c1', sourceRef: input.sourceRef, sourceVersion: input.ingestedVersion }],
    pages: [],
  }),
  conflict: (input) => ({
    workspaceId: 'fixture',
    sources: [],
    claims: [
      {
        claimId: 'canonical-1',
        status: 'canonical',
        sourceRef: 'https://example.invalid/doc/c',
        sourceVersion: 'rev-1',
        subject: input.canonicalClaim.subject,
        relation: input.canonicalClaim.relation,
        object: input.canonicalClaim.object,
      },
      {
        claimId: 'candidate-1',
        status: 'candidate',
        sourceRef: 'https://example.invalid/doc/c',
        sourceVersion: 'rev-2',
        subject: input.candidateClaim.subject,
        relation: input.candidateClaim.relation,
        object: input.candidateClaim.object,
        conflictsWith: 'canonical-1',
      },
    ],
    pages: [],
  }),
  'missing-provenance': (input) => ({
    workspaceId: 'fixture',
    sources: [],
    claims: [{
      claimId: 'no-provenance',
      sourceRef: input.sourceRef,
      sourceVersion: input.sourceVersion,
      contentHash: input.contentHash,
    }],
    pages: [],
  }),
  'orphan-page': (input) => ({
    workspaceId: 'fixture',
    sources: [],
    claims: [],
    pages: [{ pageId: input.page, inboundLinks: input.inboundLinks }],
  }),
};

test('the lint reports the schema version, the workspace and the surfaces it read', () => {
  const report = lintKnowledgeState({ workspaceId: 'w1', sources: [], claims: [], pages: [] });
  assert.equal(report.schemaVersion, KNOWLEDGE_LINT_SCHEMA_VERSION);
  assert.equal(report.workspaceId, 'w1');
  assert.deepEqual(report.surfaces, [...LINT_SURFACES]);
  assert.deepEqual(report.findings, []);
});

test('every fixture condition maps to a finding the lint actually produces', () => {
  const expectedCode = {
    'source-drift': LINT_CODES.SOURCE_DRIFT,
    conflict: LINT_CODES.CONFLICT,
    'missing-provenance': LINT_CODES.MISSING_PROVENANCE,
    'orphan-page': LINT_CODES.ORPHAN_PAGE,
  };
  for (const [id, code] of Object.entries(expectedCode)) {
    const report = lintKnowledgeState(stateFor[id](inputsOf(id)));
    assert.deepEqual(codes(report), [code], `${id} should report exactly ${code}`);
  }
});

test('the expected finding of each data case is the one the fixture declares', () => {
  const built = {
    'source-drift': LINT_CODES.SOURCE_DRIFT,
    conflict: LINT_CODES.CONFLICT,
    'missing-provenance': LINT_CODES.MISSING_PROVENANCE,
    'orphan-page': LINT_CODES.ORPHAN_PAGE,
  };
  for (const [id, code] of Object.entries(built)) {
    assert.equal(expectedOf(id).finding, code, `${id}: fixture expectation must match the lint code`);
    assert.equal(expectedOf(id).mutation, false);
  }
});

test('source drift needs two hashes: an absent or equal pair is not drift', () => {
  const base = { sourceRef: 'https://example.invalid/doc/x', sourceVersion: 'rev-1' };
  const claim = { claimId: 'c', sourceRef: base.sourceRef, sourceVersion: 'rev-1' };
  const noPinned = lintKnowledgeState({ sources: [{ ...base, currentContentHash: 'aa' }], claims: [claim], pages: [] });
  const equal = lintKnowledgeState({ sources: [{ ...base, contentHash: 'aa', currentContentHash: 'aa' }], claims: [claim], pages: [] });
  assert.deepEqual(codes(noPinned), []);
  assert.deepEqual(codes(equal), []);
});

test('a missing sourceVersion is reported, never invented', () => {
  const report = lintKnowledgeState({
    sources: [],
    claims: [{ claimId: 'partial', sourceRef: 'https://example.invalid/doc/y' }],
    pages: [],
  });
  assert.deepEqual(codes(report), [LINT_CODES.MISSING_PROVENANCE]);
  assert.equal(report.findings[0].sourceVersion, '');
  assert.equal(report.findings[0].missing, 'sourceVersion');
});

test('a source nothing derives a claim from is a coverage gap', () => {
  const report = lintKnowledgeState({
    sources: [{ sourceRef: 'https://example.invalid/doc/z', sourceVersion: 'rev-1' }],
    claims: [],
    pages: [],
  });
  assert.deepEqual(codes(report), [LINT_CODES.COVERAGE_GAP]);
});

test('a page with no measured link count is not reported as an orphan', () => {
  const report = lintKnowledgeState({ sources: [], claims: [], pages: [{ pageId: 'p' }] });
  assert.deepEqual(codes(report), []);
});

test('no finding authorizes a mutation, a promotion or an authoritative claim', () => {
  const report = lintKnowledgeState(stateFor['conflict'](inputsOf('conflict')));
  assert.ok(report.findings.length > 0);
  for (const item of report.findings) {
    assert.equal(item.mutation, false);
    assert.equal(item.authoritative, false);
  }
  assert.equal(report.findings[0].canonicalPromotion, false);
});

test('lint read-only: the state digest is identical before and after the run', () => {
  const input = inputsOf('lint-read-only');
  const state = {
    workspaceId: 'fixture',
    sources: [{ sourceRef: 'https://example.invalid/doc/a', sourceVersion: 'rev-1', contentHash: 'aa', currentContentHash: 'aa' }],
    claims: [{ claimId: 'c1', sourceRef: 'https://example.invalid/doc/a', sourceVersion: 'rev-1' }],
    pages: [{ pageId: 'topics/a', inboundLinks: 1 }],
  };
  const snapshot = structuredClone(state);
  const before = stateDigest(state);

  const report = lintKnowledgeState(state);

  assert.equal(stateDigest(state), before, 'the state digest must not move');
  assert.deepEqual(state, snapshot, 'the state must be byte-identical after the run');
  assert.equal(report.readOnly, true);
  assert.equal(report.mutation, false);
  assert.equal(report.stateChanged, false);
  assert.equal(report.observedStateDigest, before);
  assert.deepEqual(report.surfaces, input.surfaces);
});

test('an accessor is refused before the digest reads it', () => {
  // A state whose `sources` getter records that it was read. The digest would
  // invoke this getter, so it could mutate another field and be absorbed into
  // the before-state; refusing accessors first is what keeps that impossible.
  // The getter must never run -- if it did, `readCount` would be set.
  const state = { workspaceId: 'w', claims: [], pages: [] };
  Object.defineProperty(state, 'sources', {
    enumerable: true,
    get() {
      state.readCount = (state.readCount || 0) + 1;
      return [];
    },
  });
  assert.throws(() => lintKnowledgeState(state), (error) => error.code === 'KNOWLEDGE_LINT_STATE_ACCESSOR');
  assert.equal(state.readCount, undefined, 'the refused accessor must not have run');
});

test('a nested accessor is refused too, not only one on the root', () => {
  const record = {};
  Object.defineProperty(record, 'sourceRef', { enumerable: true, get: () => 'https://example.invalid/doc/a' });
  const state = { workspaceId: 'w', sources: [record], claims: [], pages: [] };
  assert.throws(() => lintKnowledgeState(state), (error) => error.code === 'KNOWLEDGE_LINT_STATE_ACCESSOR');
});

test('an unserializable state is refused with a stable code', () => {
  // `JSON.stringify` throws on a BigInt; the caller should see the lint's own
  // code rather than a raw helper TypeError.
  const state = { workspaceId: 'w', sources: [], claims: [], pages: [] };
  state.claims = [{ claimId: 'c1', sourceRef: 'r', sourceVersion: 'v', weight: 1n }];
  assert.throws(() => lintKnowledgeState(state), (error) => error.code === 'KNOWLEDGE_LINT_STATE_UNSERIALIZABLE');
});

test('lint read-only is checked, not promised: a state that moves under it throws', () => {
  // A plain-data state cannot move, so this drives the tripwire through a
  // Proxy whose `sources` value differs between the first and the second read.
  // The record is a real change to the object, so the after-digest differs
  // from the before one and the run must refuse to return a report about a
  // state it altered.
  let reads = 0;
  const state = new Proxy(
    { workspaceId: 'w', sources: [], claims: [], pages: [] },
    {
      get(target, key, receiver) {
        if (key === 'sources') return reads++ === 0 ? [] : [{ sourceRef: 'late', sourceVersion: 'v' }];
        return Reflect.get(target, key, receiver);
      },
    },
  );
  assert.throws(() => lintKnowledgeState(state), (error) => error.code === 'KNOWLEDGE_LINT_MUTATED_STATE');
});

test('restart idempotency: two runs over the same versions give the identical report', () => {
  const input = inputsOf('restart-idempotency');
  const state = {
    workspaceId: 'fixture',
    sources: input.sourceVersions.map((version, index) => ({
      sourceRef: `https://example.invalid/doc/${index}`,
      sourceVersion: version,
      contentHash: 'aa',
      currentContentHash: 'aa',
    })),
    claims: input.sourceVersions.map((version, index) => ({
      claimId: `c${index}`,
      sourceRef: `https://example.invalid/doc/${index}`,
      sourceVersion: version,
    })),
    pages: [],
  };
  const first = lintKnowledgeState(state);
  const second = lintKnowledgeState(state);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('idempotent re-ingest: the same state never yields a duplicate finding', () => {
  const state = stateFor['source-drift'](inputsOf('source-drift'));
  const first = lintKnowledgeState(state);
  const second = lintKnowledgeState(state);
  assert.equal(first.findings.length, second.findings.length);
  assert.deepEqual(codes(second), codes(first));
});

test('a non-object state is refused rather than guessed at', () => {
  for (const bad of [null, undefined, 42, 'state', []]) {
    assert.throws(() => lintKnowledgeState(bad), (error) => error.code === 'KNOWLEDGE_LINT_STATE_REQUIRED');
  }
});
