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
const { REFUSAL_REASONS, applyDerivation } = require('../lib/coder/apply-derivation');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-'));
  return fs.realpathSync(root);
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function docsTask(overrides = {}) {
  return {
    id: 'task-docs-1',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
    ...overrides,
  };
}

// A clean feature branch: the gate blocks writes on main and reviews a dirty
// tree, so tests that expect `allow` must say which tree they are running in.
const CLEAN_BRANCH = { branch: 'feat/coder', dirty: false, hasUntracked: false };

describe('derivation record', () => {
  const base = {
    taskId: 't1',
    operationType: 'replace_text',
    allowedPaths: ['docs/notes.md'],
    inputFiles: { 'docs/notes.md': 'version v1.0.0\n' },
    patch: [{ path: 'docs/notes.md', before: 'version v1.0.0\n', after: 'version v1.1.0\n' }],
    runnerStatus: 'COMPLETED',
    runnerReason: null,
    outcome: DERIVATION_OUTCOMES.APPLIED,
  };

  it('gives the same derivationHash for the same inputs at a different time', () => {
    const first = buildDerivationRecord({ ...base, createdAt: '2026-01-01T00:00:00.000Z' });
    const second = buildDerivationRecord({ ...base, createdAt: '2027-06-30T12:34:56.000Z' });

    assert.equal(first.derivationHash, second.derivationHash);
    // The run identity must still differ, or the record could not distinguish
    // two separate runs of the same derivation.
    assert.notEqual(first.recordHash, second.recordHash);
  });

  it('changes the derivationHash when an input file differs', () => {
    const original = buildDerivationRecord({ ...base, createdAt: '2026-01-01T00:00:00.000Z' });
    const altered = buildDerivationRecord({
      ...base,
      createdAt: '2026-01-01T00:00:00.000Z',
      inputFiles: { 'docs/notes.md': 'version v1.0.0 (edited)\n' },
    });

    assert.notEqual(original.derivationHash, altered.derivationHash);
  });

  it('records a declared-but-missing input rather than dropping it', () => {
    const present = buildDerivationRecord({ ...base, createdAt: '2026-01-01T00:00:00.000Z' });
    const missing = buildDerivationRecord({
      ...base,
      createdAt: '2026-01-01T00:00:00.000Z',
      inputFiles: {},
    });

    assert.equal(missing.inputs.length, 1);
    assert.equal(missing.inputs[0].sha256, 'absent');
    assert.notEqual(present.derivationHash, missing.derivationHash);
  });

  it('detects a record whose contents no longer match its derivationHash', () => {
    const record = buildDerivationRecord({ ...base, createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(verifyDerivationHash(record).ok, true);

    const tampered = { ...record, operationType: 'insert_after' };
    const verdict = verifyDerivationHash(tampered);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'DERIVATION_HASH_MISMATCH');
  });

  it('refuses to build a record for an unknown outcome', () => {
    assert.throws(
      () => buildDerivationRecord({ ...base, outcome: 'probably_fine', createdAt: 'x' }),
      /known outcome/u,
    );
  });
});

describe('applyDerivation', () => {
  it('writes the derived patch when the gate allows it', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const result = applyDerivation({ task: docsTask(), root, repoState: CLEAN_BRANCH });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.equal(result.gate.decision, 'allow');
    assert.equal(read(root, 'docs/notes.md'), 'release v1.1.0 shipped\n');
    assert.equal(verifyDerivationHash(result.record).ok, true);
  });

  it('produces the identical derivationHash on a second, independent tree', () => {
    const first = makeRoot();
    const second = makeRoot();
    write(first, 'docs/notes.md', 'release v1.0.0 shipped\n');
    write(second, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const a = applyDerivation({ task: docsTask(), root: first, repoState: CLEAN_BRANCH });
    const b = applyDerivation({ task: docsTask(), root: second, repoState: CLEAN_BRANCH });

    assert.equal(a.record.derivationHash, b.record.derivationHash);
  });

  it('does not write anything on a dry run, but still records the derivation', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const result = applyDerivation({ task: docsTask(), root, repoState: CLEAN_BRANCH, dryRun: true });

    assert.equal(result.outcome, DERIVATION_OUTCOMES.DRY_RUN);
    assert.equal(read(root, 'docs/notes.md'), 'release v1.0.0 shipped\n');
    assert.equal(result.record.patch.length, 1);
  });

  it('refuses to write on main even though the transform succeeded', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const result = applyDerivation({
      task: docsTask(),
      root,
      repoState: { branch: 'main', dirty: false, hasUntracked: false },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.GATE_REFUSED);
    assert.equal(result.gate.reason, 'MAIN_BRANCH_WRITE_BLOCKED');
    // The transform did its job; only the gate stopped the write.
    assert.equal(result.record.runnerStatus, 'COMPLETED');
    assert.equal(read(root, 'docs/notes.md'), 'release v1.0.0 shipped\n');
  });

  it('stops a source-file change at review instead of applying it', () => {
    const root = makeRoot();
    write(root, 'lib/thing.js', "const version = 'v1.0.0';\n");

    const result = applyDerivation({
      task: docsTask({
        allowedPaths: ['lib/thing.js'],
        operation: { type: 'replace_text', path: 'lib/thing.js', find: 'v1.0.0', replace: 'v1.1.0' },
      }),
      root,
      repoState: CLEAN_BRANCH,
    });

    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.equal(read(root, 'lib/thing.js'), "const version = 'v1.0.0';\n");
  });

  it('refuses an ambiguous transform without reaching the gate', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'v1.0.0 and again v1.0.0\n');

    const result = applyDerivation({ task: docsTask(), root, repoState: CLEAN_BRANCH });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.TRANSFORM_REFUSED);
    assert.equal(result.record.runnerReason, 'REPLACEMENT_NOT_UNIQUE');
    assert.equal(result.record.gate.decision, '');
  });

  it('refuses a task whose declared path escapes the root', () => {
    const root = makeRoot();

    const result = applyDerivation({
      task: docsTask({
        allowedPaths: ['../outside.md'],
        operation: { type: 'replace_text', path: '../outside.md', find: 'a', replace: 'b' },
      }),
      root,
      repoState: CLEAN_BRANCH,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.PATH_ESCAPES_ROOT);
  });

  it('rolls the tree back when a later write in the same patch fails', () => {
    const root = makeRoot();
    write(root, 'docs/schema.json', JSON.stringify({
      route: { method: 'get', path: '/health', handler: 'health' },
      required: ['status'],
    }));

    let writes = 0;
    const failingFs = {
      ...fs,
      writeFileSync(target, content, encoding) {
        writes += 1;
        // Fail the second file of a two-file patch, after the first landed.
        if (writes === 2) throw new Error('disk full');
        return fs.writeFileSync(target, content, encoding);
      },
    };

    const result = applyDerivation({
      task: {
        id: 'task-rollback',
        level: 'l1',
        allowedPaths: ['docs/schema.json', 'docs/route.md', 'docs/route.test.md'],
        operation: {
          type: 'json_schema_route_test',
          schemaPath: 'docs/schema.json',
          routePath: 'docs/route.md',
          testPath: 'docs/route.test.md',
        },
      },
      root,
      repoState: CLEAN_BRANCH,
      fs: failingFs,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.WRITE_FAILED);
    // Neither file may survive: both were absent before the patch ran.
    assert.equal(fs.existsSync(path.join(root, 'docs/route.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'docs/route.test.md')), false);
  });
});
