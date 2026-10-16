'use strict';

// #3670: the coder could not create a file, and a fix that touched one file
// twice had to be two tasks -- two runs, the second on a tree the first had
// dirtied, and two records stacked on one file that PR Guardian cannot
// re-derive against the PR base. `create_file` and `sequence` close both.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { STATUS, runTask } = require('../lib/deterministic-task-runner');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { directoryReader, verifyDerivation } = require('../lib/coder/verify-derivation');

const CLEAN_BRANCH = { branch: 'feat/sequence', dirty: false, hasUntracked: false };

function task(operation, allowedPaths, files) {
  return { id: 'sequence-case', level: 'l1', operation, allowedPaths, files };
}

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sequence-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

describe('create_file', () => {
  it('creates a file the inputs do not hold', () => {
    const result = runTask(task(
      { type: 'create_file', path: 'docs/new.md', content: '# New\n' },
      ['docs/new.md'],
      {},
    ));

    assert.equal(result.status, STATUS.COMPLETED);
    assert.deepEqual(result.patch, [{ path: 'docs/new.md', before: null, after: '# New\n' }]);
  });

  it('refuses to overwrite a file that already exists', () => {
    const files = { 'docs/new.md': 'kept\n' };
    const result = runTask(task(
      { type: 'create_file', path: 'docs/new.md', content: '# New\n' },
      ['docs/new.md'],
      files,
    ));

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'FILE_ALREADY_EXISTS');
    assert.deepEqual(result.files, files);
    assert.deepEqual(result.patch, []);
  });

  it('refuses a path outside allowedPaths', () => {
    const result = runTask(task(
      { type: 'create_file', path: 'docs/other.md', content: 'x\n' },
      ['docs/new.md'],
      {},
    ));

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'PATH_NOT_ALLOWED_OR_MISSING');
  });

  it('refuses non-string content', () => {
    const result = runTask(task({ type: 'create_file', path: 'docs/new.md', content: 42 }, ['docs/new.md'], {}));

    assert.equal(result.reason, 'OPERATION_INVALID');
  });
});

describe('sequence', () => {
  it('applies its steps in order and reports one patch entry per file', () => {
    const files = { 'lib/a.js': 'const a = 1;\n' };
    const result = runTask(task({
      type: 'sequence',
      steps: [
        { type: 'insert_after', path: 'lib/a.js', anchor: 'const a = 1;\n', insert: 'const b = 2;\n' },
        { type: 'replace_text', path: 'lib/a.js', find: 'const b = 2;', replace: 'const b = a + 1;' },
        { type: 'create_file', path: 'test/a.test.js', content: "require('../lib/a');\n" },
      ],
    }, ['lib/a.js', 'test/a.test.js'], files));

    assert.equal(result.status, STATUS.COMPLETED);
    assert.deepEqual(result.patch, [
      { path: 'lib/a.js', before: 'const a = 1;\n', after: 'const a = 1;\nconst b = a + 1;\n' },
      { path: 'test/a.test.js', before: null, after: "require('../lib/a');\n" },
    ]);
    assert.deepEqual(result.changedPaths, ['lib/a.js', 'test/a.test.js']);
    assert.equal(files['lib/a.js'], 'const a = 1;\n', 'the input map is not mutated');
  });

  it('lets a later step edit a file an earlier step created', () => {
    const result = runTask(task({
      type: 'sequence',
      steps: [
        { type: 'create_file', path: 'docs/n.md', content: 'v1\n' },
        { type: 'replace_text', path: 'docs/n.md', find: 'v1', replace: 'v2' },
      ],
    }, ['docs/n.md'], {}));

    assert.deepEqual(result.patch, [{ path: 'docs/n.md', before: null, after: 'v2\n' }]);
  });

  it('is all or nothing: a failing step leaves every file untouched', () => {
    const files = { 'lib/a.js': 'const a = 1;\n' };
    const result = runTask(task({
      type: 'sequence',
      steps: [
        { type: 'replace_text', path: 'lib/a.js', find: 'const a = 1;', replace: 'const a = 2;' },
        { type: 'insert_after', path: 'lib/a.js', anchor: 'not there', insert: 'x' },
      ],
    }, ['lib/a.js'], files));

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'STEP_2_ANCHOR_NOT_UNIQUE');
    assert.deepEqual(result.files, files);
    assert.deepEqual(result.patch, []);
  });

  it('drops a file whose steps cancel out', () => {
    const result = runTask(task({
      type: 'sequence',
      steps: [
        { type: 'replace_text', path: 'docs/n.md', find: 'v1', replace: 'v2' },
        { type: 'replace_text', path: 'docs/n.md', find: 'v2', replace: 'v1' },
      ],
    }, ['docs/n.md'], { 'docs/n.md': 'v1\n' }));

    assert.equal(result.status, STATUS.COMPLETED);
    assert.deepEqual(result.patch, []);
  });

  it('refuses a nested sequence', () => {
    const result = runTask(task({
      type: 'sequence',
      steps: [{ type: 'sequence', steps: [] }],
    }, ['docs/n.md'], {}));

    assert.equal(result.reason, 'STEP_1_NESTED_SEQUENCE');
  });

  it('refuses a step that is not an object', () => {
    for (const step of [null, 'replace_text', [{ type: 'replace_text' }]]) {
      const result = runTask(task({ type: 'sequence', steps: [step] }, ['docs/n.md'], {}));

      assert.equal(result.reason, 'STEP_1_OPERATION_INVALID', JSON.stringify(step));
    }
  });

  it('refuses an empty or missing step list', () => {
    assert.equal(runTask(task({ type: 'sequence', steps: [] }, [], {})).reason, 'OPERATION_INVALID');
    assert.equal(runTask(task({ type: 'sequence' }, [], {})).reason, 'OPERATION_INVALID');
  });
});

describe('a transform the verifier does not know', () => {
  const { buildDerivationRecord } = require('../lib/coder/derivation-record');
  const { VERIFY_REASONS } = require('../lib/coder/verify-derivation');
  const { DERIVATION_STATUS, summarizeDerivations } = require('../lib/pr-guardian/derivation-check');

  // PR Guardian runs the BASE tree's verifier, so the PR that introduces a
  // transform is always checked by code that has never heard of it. That is
  // "could not check", not "does not match" -- the same distinction a newer
  // record schema already gets.
  function recordWith(operation) {
    return buildDerivationRecord({
      operationType: operation.type,
      operation,
      allowedPaths: ['docs/n.md'],
      inputFiles: { 'docs/n.md': 'v1\n' },
      patch: [{ path: 'docs/n.md', before: 'v1\n', after: 'v2\n' }],
      runnerStatus: STATUS.COMPLETED,
      runnerReason: null,
      outcome: 'applied',
      createdAt: '2026-10-08T00:00:00.000Z',
    });
  }

  const readBase = (p) => (p === 'docs/n.md' ? 'v1\n' : null);
  const readHead = (p) => (p === 'docs/n.md' ? 'v2\n' : null);

  it('reports an unknown top-level transform as unverifiable', () => {
    const record = recordWith({ type: 'future_transform', path: 'docs/n.md' });

    const verdict = verifyDerivation({ record, readBase, readHead });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, VERIFY_REASONS.TRANSFORM_UNKNOWN_TO_VERIFIER);
  });

  it('reports an unknown sequence step as unverifiable', () => {
    const record = recordWith({ type: 'sequence', steps: [{ type: 'future_transform', path: 'docs/n.md' }] });

    const verdict = verifyDerivation({ record, readBase, readHead });

    assert.equal(verdict.reason, VERIFY_REASONS.TRANSFORM_UNKNOWN_TO_VERIFIER);
  });

  it('lands in Guardian as unknown, not failed', () => {
    const summary = summarizeDerivations({
      records: [{ path: '.huqan/derivations/x.json', record: recordWith({ type: 'future_transform', path: 'docs/n.md' }) }],
      readBase,
      readHead,
    });

    assert.equal(summary.status, DERIVATION_STATUS.UNKNOWN);
    assert.equal(summary.failures.length, 0);
  });

  it('fails, not unknown, a sequence whose steps are malformed', () => {
    // Only an unregistered transform type is "could not check". A nested or
    // malformed step is wrong in every verifier version, so a forged record
    // must not escape into the unknown bucket through it.
    for (const steps of [[{ type: 'sequence', steps: [] }], [null]]) {
      const verdict = verifyDerivation({ record: recordWith({ type: 'sequence', steps }), readBase, readHead });

      assert.equal(verdict.reason, VERIFY_REASONS.RERUN_FAILED, JSON.stringify(steps));
    }
  });

  it('still fails a known transform that does not reproduce', () => {
    const record = recordWith({ type: 'replace_text', path: 'docs/n.md', find: 'absent', replace: 'v2' });

    const verdict = verifyDerivation({ record, readBase, readHead });

    assert.equal(verdict.reason, VERIFY_REASONS.RERUN_FAILED);
  });
});

describe('sequence through the coder pipeline', () => {
  it('applies a multi-file fix in one run and its record re-derives from the base tree', () => {
    const head = makeRoot();
    const base = makeRoot();
    for (const root of [head, base]) write(root, 'docs/guide.md', '# Guide\n\nStep one.\n');

    const result = applyDerivation({
      task: {
        id: 'sequence-pipeline',
        level: 'l1',
        allowedPaths: ['docs/guide.md', 'docs/faq.md'],
        operation: {
          type: 'sequence',
          steps: [
            { type: 'insert_after', path: 'docs/guide.md', anchor: 'Step one.\n', insert: 'Step two.\n' },
            { type: 'replace_text', path: 'docs/guide.md', find: '# Guide', replace: '# Guide (v2)' },
            { type: 'create_file', path: 'docs/faq.md', content: '# FAQ\n' },
          ],
        },
      },
      root: head,
      repoState: CLEAN_BRANCH,
    });

    assert.equal(result.outcome, 'applied', JSON.stringify(result.record && result.record.gate));
    assert.equal(fs.readFileSync(path.join(head, 'docs/guide.md'), 'utf8'), '# Guide (v2)\n\nStep one.\nStep two.\n');
    assert.equal(fs.readFileSync(path.join(head, 'docs/faq.md'), 'utf8'), '# FAQ\n');

    const verdict = verifyDerivation({
      record: result.record,
      readBase: directoryReader(base),
      readHead: directoryReader(head),
    });

    assert.equal(verdict.ok, true, verdict.detail);
    assert.deepEqual(verdict.verifiedPaths, ['docs/faq.md', 'docs/guide.md']);
  });
});
