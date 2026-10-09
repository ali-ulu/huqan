'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyDerivation } = require('../lib/coder/apply-derivation');
const { verifyDerivationHash } = require('../lib/coder/derivation-record');
const {
  PRODUCER_REASONS,
  PRODUCER_STATUSES,
  produceTask,
} = require('../lib/task-producer');

const CLEAN_BRANCH = { branch: 'feat/coder', dirty: false, hasUntracked: false };

function failure(overrides = {}) {
  return {
    kind: 'failure_record',
    schemaVersion: '1.0.0',
    failureId: 'failure-abc123',
    source: 'test_failure',
    verificationStatus: 'verified',
    trust: 'high',
    verificationReason: 'verified_by_authority',
    action: {
      tool: 'coder',
      operation: 'replace_text',
      workspaceId: 'default',
      repo: 'huqan',
      path: 'docs/notes.md',
      actionFingerprint: 'fp-1',
    },
    expected: 'version v1.1.0\n',
    observed: 'version v1.0.0\n',
    evidence: [],
    workspaceId: 'default',
    ...overrides,
  };
}

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-producer-')));
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('task producer', () => {
  it('projects a verified replace_text failure onto a bounded transform task', () => {
    const result = produceTask(failure());

    assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(result.reason, null);
    assert.equal(result.sourceFailureId, 'failure-abc123');
    assert.deepEqual(result.task.allowedPaths, ['docs/notes.md']);
    assert.equal(result.task.operation.type, 'replace_text');
    assert.equal(result.task.operation.path, 'docs/notes.md');
  });

  it('searches for the observed text and writes the expected text, not the reverse', () => {
    const { task } = produceTask(failure());

    // The failure says v1.0.0 was there and v1.1.0 should have been. A
    // producer that swapped these would "fix" the file by making it reproduce
    // the failure.
    assert.equal(task.operation.find, 'version v1.0.0\n');
    assert.equal(task.operation.replace, 'version v1.1.0\n');
  });

  it('carries allowedPaths and the operation and nothing else that widens authority', () => {
    const { task } = produceTask(failure());

    assert.equal(task.requiresHumanDecision, undefined);
    assert.equal(task.expectedPatch, undefined);
    assert.equal(task.files && Object.keys(task.files).length, 0);
  });

  it('derives the task id from the failure id so a re-run is the same task', () => {
    const first = produceTask(failure()).task;
    const second = produceTask(failure()).task;

    assert.equal(first.id, 'task-failure-abc123');
    assert.equal(first.id, second.id);
  });

  it('refuses a failure that was not verified', () => {
    for (const status of ['candidate', 'unverified', '', undefined]) {
      const result = produceTask(failure({ verificationStatus: status }));
      assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
      assert.equal(result.reason, PRODUCER_REASONS.FAILURE_NOT_VERIFIED);
      assert.equal(result.task, null);
    }
  });

  it('returns needs_human_decision rather than a guessed task for an unsupported operation', () => {
    // json_schema_route_test needs a whole schema, which a failure record does
    // not carry, so it stays unmappable -- refusing it is the correct answer,
    // not a gap in the catalog.
    const result = produceTask(failure({ action: { operation: 'json_schema_route_test', path: 'docs/notes.md' } }));

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.NO_SUPPORTED_OPERATION);
    assert.equal(result.task, null);
  });

  it('projects a verified insert_after failure by reading observed as the anchor and expected as the insert', () => {
    const result = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'const x = 1;',
      expected: '\nconst y = 2;',
    }));

    assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(result.task.operation.type, 'insert_after');
    assert.equal(result.task.operation.anchor, 'const x = 1;');
    assert.equal(result.task.operation.insert, '\nconst y = 2;');
  });

  it('refuses an insert_after failure whose anchor is not unique in the held file', () => {
    const result = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'x',
      expected: 'y',
    }), { files: { 'docs/notes.md': 'x x' } });

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.ANCHOR_NOT_UNIQUE);
    assert.equal(result.task, null);
  });

  it('projects a verified rename_identifier failure only when both halves are real identifiers', () => {
    const renamed = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'oldName',
      expected: 'newName',
    }));
    assert.equal(renamed.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(renamed.task.operation.type, 'rename_identifier');
    assert.equal(renamed.task.operation.from, 'oldName');
    assert.equal(renamed.task.operation.to, 'newName');

    const notIdentifiers = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'old name',
      expected: 'new name',
    }));
    assert.equal(notIdentifiers.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(notIdentifiers.reason, PRODUCER_REASONS.IDENTIFIER_PAIR_INVALID);
    assert.equal(notIdentifiers.task, null);
  });

  it('refuses a failure whose path is absolute or escapes the root', () => {
    for (const declared of ['/etc/passwd', 'C:/Windows/system32/drivers', '../../outside.md']) {
      const result = produceTask(failure({ action: { operation: 'replace_text', path: declared } }));
      assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
      assert.equal(result.reason, PRODUCER_REASONS.FAILURE_PATH_ESCAPES_ROOT);
      assert.equal(result.task, null);
    }
  });

  it('refuses a failure that does not carry both halves of the replacement', () => {
    const noExpected = produceTask(failure({ expected: '' }));
    assert.equal(noExpected.reason, PRODUCER_REASONS.FAILURE_EXPECTED_MISSING);

    const noObserved = produceTask(failure({ observed: '' }));
    assert.equal(noObserved.reason, PRODUCER_REASONS.FAILURE_OBSERVED_MISSING);

    const same = produceTask(failure({ expected: 'x', observed: 'x' }));
    assert.equal(same.reason, PRODUCER_REASONS.FAILURE_EXPECTED_EQUALS_OBSERVED);
    assert.equal(same.task, null);
  });

  it('refuses when the replacement would not occur exactly once', () => {
    const content = 'v1.0.0\nv1.0.0\n';
    const result = produceTask(failure({ observed: 'v1.0.0', expected: 'v1.1.0' }), {
      files: { 'docs/notes.md': content },
    });

    assert.equal(result.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, PRODUCER_REASONS.REPLACEMENT_NOT_UNIQUE);
    assert.equal(result.task, null);
  });

  it('rejects anything that is not a failure record', () => {
    assert.equal(produceTask(null).reason, PRODUCER_REASONS.FAILURE_NOT_OBJECT);
    assert.equal(produceTask({ kind: 'rule' }).reason, PRODUCER_REASONS.FAILURE_KIND_INVALID);
    assert.equal(produceTask(failure({ failureId: '' })).reason, PRODUCER_REASONS.FAILURE_ID_MISSING);
  });

  it('writes nothing to disk', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    const before = fs.readdirSync(root, { recursive: true }).sort();
    produceTask(failure());
    produceTask(failure({ verificationStatus: 'candidate' }));
    const after = fs.readdirSync(root, { recursive: true }).sort();

    assert.deepEqual(after, before);
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('runs against a read-only tree without failing', () => {
    if (process.platform === 'win32' || process.getuid === undefined) {
      return; // chmod does not deny writes to the owner on Windows.
    }
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');
    fs.chmodSync(path.join(root, 'docs'), 0o500);

    try {
      const result = produceTask(failure());
      assert.equal(result.status, PRODUCER_STATUSES.TASK_PRODUCED);
    } finally {
      fs.chmodSync(path.join(root, 'docs'), 0o700);
    }
  });
});

describe('produced task through the coder pipeline', () => {
  it('reproduces the intended change under --dry-run with a stable derivationHash', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    const { task } = produceTask(failure());

    const first = applyDerivation({ task, root, repoState: CLEAN_BRANCH, dryRun: true });
    const second = applyDerivation({ task, root, repoState: CLEAN_BRANCH, dryRun: true });

    assert.equal(first.ok, true);
    assert.equal(first.outcome, 'dry_run');
    assert.deepEqual(first.patch, [{
      path: 'docs/notes.md',
      before: 'version v1.0.0\n',
      after: 'version v1.1.0\n',
    }]);

    // Dry-run must not have touched the tree.
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');

    assert.equal(first.record.derivationHash, second.record.derivationHash);
    assert.equal(verifyDerivationHash(first.record).ok, true);
  });

  it('applies the change when the gate allows it, and still answers to the gate when it does not', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');
    const { task } = produceTask(failure());

    const applied = applyDerivation({ task, root, repoState: CLEAN_BRANCH });
    assert.equal(applied.ok, true);
    assert.equal(applied.outcome, 'applied');
    assert.equal(read(root, 'docs/notes.md'), 'version v1.1.0\n');

    // The gate is not bypassed by the producer: on main it still refuses.
    const second = makeRoot();
    write(second, 'docs/notes.md', 'version v1.0.0\n');
    const refused = applyDerivation({
      task,
      root: second,
      repoState: { branch: 'main', dirty: false, hasUntracked: false },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'GATE_REFUSED');
    assert.equal(read(second, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('a task nobody could map never reaches a write, because there is no task', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'version v1.0.0\n');

    // json_schema_route_test is the shape a failure record cannot carry.
    const result = produceTask(failure({ action: { operation: 'json_schema_route_test', path: 'docs/notes.md' } }));

    assert.equal(result.task, null);
    assert.equal(read(root, 'docs/notes.md'), 'version v1.0.0\n');
  });

  it('applies a produced insert_after task and a produced rename_identifier task through the gate', () => {
    const insertRoot = makeRoot();
    write(insertRoot, 'docs/notes.md', 'before\n');
    const insert = produceTask(failure({
      action: { operation: 'insert_after', path: 'docs/notes.md' },
      observed: 'before\n',
      expected: 'after\n',
    })).task;
    const inserted = applyDerivation({ task: insert, root: insertRoot, repoState: CLEAN_BRANCH });
    assert.equal(inserted.outcome, 'applied');
    assert.equal(read(insertRoot, 'docs/notes.md'), 'before\nafter\n');

    const renameRoot = makeRoot();
    write(renameRoot, 'src/thing.js', 'const oldName = 1;\n');
    const rename = produceTask(failure({
      action: { operation: 'rename_identifier', path: 'src/thing.js' },
      observed: 'oldName',
      expected: 'newName',
    })).task;
    // A source-file change is refused until an operator authorizes it: the
    // proposal confers nothing, and the gate is what decides.
    const unauthorized = applyDerivation({ task: rename, root: renameRoot, repoState: CLEAN_BRANCH });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.reason, 'GATE_REFUSED');
    assert.equal(read(renameRoot, 'src/thing.js'), 'const oldName = 1;\n');

    const renamed = applyDerivation({ task: rename, root: renameRoot, repoState: CLEAN_BRANCH, authorized: true });
    assert.equal(renamed.outcome, 'applied');
    assert.equal(read(renameRoot, 'src/thing.js'), 'const newName = 1;\n');
  });
});
