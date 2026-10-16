'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DERIVATION_OUTCOMES,
  buildDerivationRecord,
  verifyDerivationHash,
} = require('../lib/coder/derivation-record');
const { applyDerivation } = require('../lib/coder/apply-derivation');

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3031-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function docsTask() {
  return {
    id: 'task-3031',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
  };
}

const CLEAN_BRANCH = { branch: 'feat/3031', dirty: false, hasUntracked: false };

describe('issue #3031 observed verification seam', () => {
  it('with no seam the record says ran:false and behaves as before', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const result = applyDerivation({ task: docsTask(), root, repoState: CLEAN_BRANCH });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.deepEqual(result.record.observedVerification, {
      ran: false, ok: null, command: null, evidenceRef: null,
    });
    assert.equal(result.observedVerification.ran, false);
  });

  it('a failing seam keeps APPLIED with its hash intact and reports ok:false', () => {
    const plainRoot = makeRoot();
    const seamRoot = makeRoot();
    write(plainRoot, 'docs/notes.md', 'release v1.0.0 shipped\n');
    write(seamRoot, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const plain = applyDerivation({ task: docsTask(), root: plainRoot, repoState: CLEAN_BRANCH });
    const result = applyDerivation({
      task: docsTask(),
      root: seamRoot,
      repoState: CLEAN_BRANCH,
      verifyCommand: 'npm test',
      verify: () => ({ ok: false, command: 'npm test', evidenceRef: '3 failed' }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.deepEqual(result.record.observedVerification, {
      ran: true, ok: false, command: 'npm test', evidenceRef: '3 failed',
    });
    assert.equal(result.record.derivationHash, plain.record.derivationHash);
    assert.equal(verifyDerivationHash(result.record).ok, true);
  });

  it('never folds the observed field into the derivationHash', () => {
    const base = {
      taskId: 't',
      operationType: 'replace_text',
      allowedPaths: ['a'],
      inputFiles: { a: 'x' },
      patch: [{ path: 'a', before: 'x', after: 'y' }],
      runnerStatus: 'COMPLETED',
      runnerReason: null,
      outcome: DERIVATION_OUTCOMES.APPLIED,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const absent = buildDerivationRecord(base);
    const observed = buildDerivationRecord({
      ...base,
      observedVerification: { ran: true, ok: true, command: 'npm test', evidenceRef: 'ok' },
    });

    assert.equal(absent.derivationHash, observed.derivationHash);
    assert.equal(verifyDerivationHash(observed).ok, true);
  });
});
