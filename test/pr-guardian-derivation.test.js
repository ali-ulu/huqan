'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DERIVATION_STATUS,
  isDerivationRecordPath,
  summarizeDerivations,
} = require('../lib/pr-guardian/derivation-check');
const { evaluatePullRequest, DECISIONS } = require('../lib/pr-guardian/policy');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { directoryReader } = require('../lib/coder/verify-derivation');

const BASE_CONTENT = 'release v1.0.0 shipped\n';

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-guard-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

/** A real record from a real run, plus the base tree it was derived from. */
function derive() {
  const head = makeRoot();
  const base = makeRoot();
  write(head, 'docs/notes.md', BASE_CONTENT);
  write(base, 'docs/notes.md', BASE_CONTENT);

  const result = applyDerivation({
    task: {
      id: 'guard-fixture',
      level: 'l0',
      allowedPaths: ['docs/notes.md'],
      operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
    },
    root: head,
    repoState: { branch: 'feat/guard', dirty: false, hasUntracked: false },
  });
  assert.equal(result.outcome, 'applied');
  return { record: result.record, base, head };
}

/**
 * A record that is internally consistent but declares a different schema —
 * what a verifier running from an older base tree actually meets after a schema
 * bump. Editing `schemaVersion` in place would not reproduce it: that breaks
 * the record's own hash and the integrity check answers first, which is a
 * different failure from the one being tested here.
 */
function atSchema(record, schemaVersion) {
  const { hashDerivationCore } = require('../lib/coder/derivation-record');
  const { stableStringify, sha256Hex } = require('../lib/receipt/canonical-receipt');
  const core = {
    schemaVersion,
    catalogVersion: record.catalogVersion,
    operationType: record.operationType,
    operation: record.operation,
    allowedPaths: record.allowedPaths,
    inputs: record.inputs,
    patch: record.patch,
    runnerStatus: record.runnerStatus,
    runnerReason: record.runnerReason,
  };
  const rebuilt = {
    ...record,
    schemaVersion,
    derivationHash: hashDerivationCore(core),
  };
  delete rebuilt.recordHash;
  return { ...rebuilt, recordHash: sha256Hex(stableStringify(rebuilt)) };
}

function summarize(fixture, records) {
  return summarizeDerivations({
    records,
    readBase: directoryReader(fixture.base),
    readHead: directoryReader(fixture.head),
  });
}

function snapshot(extra = {}) {
  return {
    repo: 'ali-ulu/huqan',
    headSha: 'a'.repeat(40),
    workspaceId: 'github:ali-ulu/huqan',
    files: [{ filename: 'docs/notes.md', patch: '' }],
    ...extra,
  };
}

describe('derivation record paths', () => {
  it('recognises records by their committed location', () => {
    assert.equal(isDerivationRecordPath('.huqan/derivations/a.json'), true);
    assert.equal(isDerivationRecordPath('.huqan/derivations/nested/a.json'), true);
    assert.equal(isDerivationRecordPath('docs/a.json'), false);
    assert.equal(isDerivationRecordPath('.huqan/derivations/a.md'), false);
    assert.equal(isDerivationRecordPath(''), false);
  });
});

describe('summarizeDerivations', () => {
  it('reports none when the change carries no records', () => {
    const summary = summarizeDerivations({ records: [], readBase: () => null, readHead: () => null });

    assert.equal(summary.status, DERIVATION_STATUS.NONE);
    assert.equal(summary.total, 0);
  });

  it('verifies a record it can reproduce', () => {
    const fixture = derive();

    const summary = summarize(fixture, [{ path: '.huqan/derivations/one.json', record: fixture.record }]);

    assert.equal(summary.status, DERIVATION_STATUS.VERIFIED);
    assert.equal(summary.verified, 1);
    assert.deepEqual(summary.verifiedPaths, ['docs/notes.md']);
  });

  it('fails a record whose file is not what the transform derives', () => {
    const fixture = derive();
    // The record is untouched and re-derives cleanly; the tree does not match it.
    write(fixture.head, 'docs/notes.md', 'release v9.9.9 shipped\n');

    const summary = summarize(fixture, [{ path: '.huqan/derivations/one.json', record: fixture.record }]);

    assert.equal(summary.status, DERIVATION_STATUS.FAILED);
    assert.equal(summary.verified, 0);
    assert.equal(summary.failures[0].reason, 'HEAD_MISMATCH');
    assert.equal(summary.failures[0].path, '.huqan/derivations/one.json');
  });

  it('reports unknown when the record list could not be read in full', () => {
    const summary = summarizeDerivations({ records: [], readBase: () => null, readHead: () => null, complete: false });

    assert.equal(summary.status, DERIVATION_STATUS.UNKNOWN);
  });

  it('records a verifier that throws as an unproven record, not a bad one', () => {
    const fixture = derive();
    const exploding = () => { throw new Error('reader exploded'); };

    const summary = summarizeDerivations({
      records: [{ path: '.huqan/derivations/one.json', record: fixture.record }],
      readBase: exploding,
      readHead: directoryReader(fixture.head),
    });

    // A reviewer that broke has told us nothing about the change, so this must
    // not be the status that sends the change to review.
    assert.equal(summary.status, DERIVATION_STATUS.UNKNOWN);
    assert.equal(summary.unverifiable[0].reason, 'VERIFIER_ERROR');
    assert.deepEqual(summary.failures, []);
  });

  it('treats a record from a newer schema as unverifiable, not as a failure', () => {
    const fixture = derive();
    // What actually happens on a schema bump: the verifier runs from the base
    // tree, which predates the new schema. Calling that a failure would send
    // every such change to review over the reviewer's own age.
    const newer = atSchema(fixture.record, 'huqan-derivation-v99');

    const summary = summarize(fixture, [{ path: '.huqan/derivations/one.json', record: newer }]);

    assert.equal(summary.status, DERIVATION_STATUS.UNKNOWN);
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.unverifiable.length, 1);
  });

  it('lets a real failure outrank an unverifiable record', () => {
    const fixture = derive();
    write(fixture.head, 'docs/notes.md', 'release v9.9.9 shipped\n');
    const newer = atSchema(fixture.record, 'huqan-derivation-v99');

    const summary = summarize(fixture, [
      { path: '.huqan/derivations/newer.json', record: newer },
      { path: '.huqan/derivations/bad.json', record: fixture.record },
    ]);

    assert.equal(summary.status, DERIVATION_STATUS.FAILED);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.unverifiable.length, 1);
  });
});

describe('collectDerivations', () => {
  const { collectDerivations, headReader, pathsNeededBy } = require('../lib/pr-guardian/derivation-fetch');

  function fakeFetch(responses) {
    return async function fetchImpl(url) {
      for (const [needle, value] of Object.entries(responses)) {
        if (!url.includes(encodeURI(needle))) continue;
        if (value === 404) return { status: 404, ok: false };
        if (typeof value === 'number') return { status: value, ok: false };
        return { status: 200, ok: true, text: async () => value };
      }
      return { status: 404, ok: false };
    };
  }

  const args = { api: 'https://api.github.com', repo: 'o/r', ref: 'sha', token: 't' };

  it('ignores a change with no record files', async () => {
    const out = await collectDerivations({
      ...args,
      files: [{ filename: 'lib/thing.js' }],
      fetchImpl: fakeFetch({}),
    });

    assert.deepEqual(out.records, []);
    assert.equal(out.complete, true);
  });

  it('reads a record and the head files it needs', async () => {
    const record = { allowedPaths: ['docs/a.md'], patch: [{ path: 'docs/a.md' }] };
    const out = await collectDerivations({
      ...args,
      files: [{ filename: '.huqan/derivations/one.json' }],
      fetchImpl: fakeFetch({
        '.huqan/derivations/one.json': JSON.stringify(record),
        'docs/a.md': 'derived content\n',
      }),
    });

    assert.equal(out.records.length, 1);
    assert.equal(out.complete, true);
    assert.equal(headReader(out.headFiles)('docs/a.md'), 'derived content\n');
    assert.equal(headReader(out.headFiles)('docs/missing.md'), null);
  });

  it('treats an unreadable record as incomplete rather than absent', async () => {
    const out = await collectDerivations({
      ...args,
      files: [{ filename: '.huqan/derivations/one.json' }],
      fetchImpl: fakeFetch({ '.huqan/derivations/one.json': 500 }),
    });

    assert.equal(out.complete, false);
  });

  it('treats an unparseable record as incomplete rather than skipping it', async () => {
    const out = await collectDerivations({
      ...args,
      files: [{ filename: '.huqan/derivations/one.json' }],
      fetchImpl: fakeFetch({ '.huqan/derivations/one.json': 'not json at all' }),
    });

    assert.equal(out.complete, false);
    assert.equal(out.records.length, 0);
  });

  it('accepts a deleted record file as a removal, not a read failure', async () => {
    const out = await collectDerivations({
      ...args,
      files: [{ filename: '.huqan/derivations/gone.json' }],
      fetchImpl: fakeFetch({ '.huqan/derivations/gone.json': 404 }),
    });

    assert.equal(out.complete, true);
    assert.equal(out.records.length, 0);
  });

  it('refuses to make an unbounded number of calls', async () => {
    let calls = 0;
    const files = Array.from({ length: 60 }, (_, i) => ({ filename: `.huqan/derivations/r${i}.json` }));

    const out = await collectDerivations({
      ...args,
      files,
      fetchImpl: async () => { calls += 1; return { status: 200, ok: true, text: async () => '{}' }; },
    });

    assert.equal(out.complete, false);
    assert.equal(calls, 0, 'the bound must be applied before any request is made');
  });

  it('collects both declared and patched paths, without duplicates', () => {
    assert.deepEqual(
      pathsNeededBy({ allowedPaths: ['a', 'b'], patch: [{ path: 'b' }, { path: 'c' }] }),
      ['a', 'b', 'c'],
    );
  });
});

describe('evaluatePullRequest with a derivation signal', () => {
  it('stays silent for a change that carries no records', () => {
    const verdict = evaluatePullRequest(snapshot(), { action: 'github.pr.snapshot' });

    assert.equal(verdict.decision, DECISIONS.ALLOW);
    assert.equal(verdict.reasons.includes('derivation_not_reproducible'), false);
    assert.equal(verdict.reasons.includes('derivation_verification_unknown'), false);
    assert.equal(verdict.derivations.status, 'none');
  });

  it('stays allow when every record reproduced', () => {
    const verdict = evaluatePullRequest(
      snapshot({ derivations: { status: 'verified', total: 2, verified: 2, failures: [] } }),
      { action: 'github.pr.snapshot' },
    );

    assert.equal(verdict.decision, DECISIONS.ALLOW);
    assert.equal(verdict.derivations.verified, 2);
  });

  it('sends a change to review when a derivation did not reproduce', () => {
    const verdict = evaluatePullRequest(
      snapshot({
        derivations: {
          status: 'failed',
          total: 1,
          verified: 0,
          failures: [{ path: '.huqan/derivations/one.json', reason: 'HEAD_MISMATCH', detail: '' }],
        },
      }),
      { action: 'github.pr.snapshot' },
    );

    assert.equal(verdict.decision, DECISIONS.REVIEW);
    assert.ok(verdict.reasons.includes('derivation_not_reproducible'));
  });

  it('surfaces an unknown result without escalating it', () => {
    const verdict = evaluatePullRequest(
      snapshot({ derivations: { status: 'unknown' } }),
      { action: 'github.pr.snapshot' },
    );

    assert.equal(verdict.decision, DECISIONS.ALLOW);
    assert.ok(verdict.reasons.includes('derivation_verification_unknown'));
  });

  it('treats a malformed signal as unknown rather than as a clean result', () => {
    for (const malformed of ['verified', 42, { status: 'totally_fine' }]) {
      const verdict = evaluatePullRequest(
        snapshot({ derivations: malformed }),
        { action: 'github.pr.snapshot' },
      );
      assert.equal(verdict.derivations.status, 'unknown', `for ${JSON.stringify(malformed)}`);
      assert.ok(verdict.reasons.includes('derivation_verification_unknown'));
    }
  });

  it('does not let a failed derivation soften an existing block', () => {
    const verdict = evaluatePullRequest(
      snapshot({
        title: 'force-push the branch',
        derivations: { status: 'failed', total: 1, verified: 0, failures: [] },
      }),
      { action: 'github.pr.snapshot' },
    );

    assert.equal(verdict.decision, DECISIONS.BLOCK);
  });
});
