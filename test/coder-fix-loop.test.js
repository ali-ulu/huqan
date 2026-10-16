'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TEST_REFUSALS, runDeclaredTest } = require('../lib/coder/test-execution');
const { LOOP_OUTCOMES, LOOP_REFUSALS, runFixLoop } = require('../lib/coder/fix-loop');
const { runCliCoder } = require('../lib/cli-coder');
const coderLoop = require('../lib/coder/fix-loop');
const { createExperienceJournal } = require('../lib/experience/journal');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-loop-'));
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

// A clean feature branch: the gate blocks writes on main and reviews a dirty
// tree, so tests that expect `allow` must say which tree they are running in.
const CLEAN_BRANCH = { branch: 'feat/coder', dirty: false, hasUntracked: false };

function loopTask(overrides = {}) {
  return {
    id: 'task-loop-1',
    level: 'l0',
    intent: 'fix the failing greeting',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'hello v1', replace: 'hi v2' },
    test: { command: 'node test/check.js' },
    ...overrides,
  };
}

function fakeSpawn(responses) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return responses[calls.length - 1] || { status: 0 };
  };
  spawn.calls = calls;
  return spawn;
}

const TWO_CANDIDATES = [
  { type: 'replace_text', path: 'docs/notes.md', find: 'hello v1', replace: 'goodbye v1' },
  { type: 'replace_text', path: 'docs/notes.md', find: 'hello v1', replace: 'hi v2' },
];

describe('runDeclaredTest', () => {
  it('keeps fractional timeouts bounded above zero', () => {
    const spawn = fakeSpawn([{ status: 0 }]);
    runDeclaredTest({ test: { command: 'node test/check.js', timeoutMs: 0.5 }, root: '.', spawn });
    assert.equal(spawn.calls[0].options.timeout, 1);
  });
  it('runs the tokenized command without a shell and reports ok on exit 0', () => {
    const root = makeRoot();
    write(root, 'test/check.js', 'process.exit(0);\n');
    const spawn = fakeSpawn([{ status: 0 }]);

    const result = runDeclaredTest({ test: { command: 'node test/check.js' }, root, spawn });

    assert.equal(result.ran, true);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, null);
    assert.equal(spawn.calls.length, 1);
    // Tokenized, no shell: the args reach the program verbatim.
    assert.deepEqual(spawn.calls[0].args, ['test/check.js']);
    assert.equal(spawn.calls[0].options.shell, undefined);
  });

  it('reports a non-zero exit as a failed test with its reason', () => {
    const result = runDeclaredTest({
      test: { command: 'node test/check.js' },
      root: '.',
      spawn: fakeSpawn([{ status: 1 }]),
    });

    assert.equal(result.ran, true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TEST_FAILED');
  });

  it('reports an external SIGTERM as test failure rather than timeout', () => {
    const result = runDeclaredTest({
      test: { command: 'node test/check.js' }, root: '.',
      spawn: fakeSpawn([{ status: null, signal: 'SIGTERM' }]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.reason, 'TEST_FAILED');
  });

  it('reports a timeout as a failed test', () => {
    const result = runDeclaredTest({
      test: { command: 'node test/check.js' },
      root: '.',
      spawn: fakeSpawn([{ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TEST_TIMEOUT');
  });

  it('refuses a denylisted command without spawning it', () => {
    const spawn = fakeSpawn([]);

    const result = runDeclaredTest({ test: { command: 'rm -rf /' }, root: '.', spawn });

    assert.equal(result.ran, false);
    assert.equal(result.reason, TEST_REFUSALS.GATE_BLOCKED);
    assert.equal(spawn.calls.length, 0);
  });

  it('refuses a shell-injection command without spawning it', () => {
    const spawn = fakeSpawn([]);

    const result = runDeclaredTest({ test: { command: 'node a.js && node b.js' }, root: '.', spawn });

    assert.equal(result.ran, false);
    assert.equal(result.reason, TEST_REFUSALS.GATE_REVIEW);
    assert.equal(spawn.calls.length, 0);
  });

  it('refuses an empty or malformed test block', () => {
    assert.equal(runDeclaredTest({ test: null }).reason, TEST_REFUSALS.TEST_BLOCK_INVALID);
    assert.equal(runDeclaredTest({ test: { command: '   ' } }).reason, TEST_REFUSALS.COMMAND_NOT_DECLARED);
  });

  it('runs a real process and reports the observed exit status', () => {
    const root = makeRoot();
    write(root, 'test/check.js', 'process.exit(0);\n');

    const result = runDeclaredTest({ test: { command: 'node test/check.js' }, root });

    assert.equal(result.ran, true);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
  });

  it('runs a real failing process and reports the non-zero exit', () => {
    const root = makeRoot();
    write(root, 'test/check.js', 'process.exit(1);\n');

    const result = runDeclaredTest({ test: { command: 'node test/check.js' }, root });

    assert.equal(result.ran, true);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.reason, 'TEST_FAILED');
  });
});

describe('runFixLoop', () => {
  it('a real content test rejects the first patch and accepts the next candidate', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js',
      "const fs = require('node:fs');\n"
      + "process.exit(fs.readFileSync('docs/notes.md', 'utf8') === 'greeting: hi v2\\n' ? 0 : 1);\n");
    const result = runFixLoop({ task: loopTask({ candidates: TWO_CANDIDATES }),
      root, repoState: CLEAN_BRANCH });
    assert.equal(result.outcome, LOOP_OUTCOMES.APPLIED_TESTED);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].test.exitCode, 1);
    assert.equal(result.attempts[0].rolledBack, true);
    assert.equal(result.attempts[1].test.exitCode, 0);
    assert.equal(result.record.observedVerification.ok, true);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
  });

  it('closes failed candidates after recording the test and rollback evidence', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    const journal = createExperienceJournal();
    const result = runFixLoop({ task: loopTask(), root, repoState: CLEAN_BRANCH,
      runId: 'loop-failed', journal, spawn: fakeSpawn([{ status: 1 }]) });
    assert.equal(result.ok, false);
    const events = journal.read('loop-failed:c1');
    const closed = events.find(event => event.type === 'run_closed');
    assert.notEqual(closed.outcomeStatus, 'verified');
    assert.equal(closed.payload.evidence.test.ok, false);
    assert.equal(closed.payload.evidence.rolledBack, true);
    assert.equal(closed.payload.evidence.kept, false);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('refuses a passing test that changes the derived file', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    const result = runFixLoop({
      task: loopTask(), root, repoState: CLEAN_BRANCH,
      spawn: () => {
        write(root, 'docs/notes.md', 'unexpected content\n');
        return { status: 0 };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('does not allow callers to raise the candidate ceiling', () => {
    const result = runFixLoop({
      task: loopTask({ candidates: Array(9).fill(TWO_CANDIDATES[0]) }),
      root: makeRoot(), repoState: CLEAN_BRANCH, maxCandidates: 100,
    });
    assert.equal(result.reason, LOOP_REFUSALS.CANDIDATES_OVER_CAP);
    assert.equal(result.attempts.length, 0);
  });

  it('keeps the first candidate whose test passes and stops the loop', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const spawn = fakeSpawn([{ status: 0 }]);

    const result = runFixLoop({ task: loopTask(), root, repoState: CLEAN_BRANCH, spawn });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, LOOP_OUTCOMES.APPLIED_TESTED);
    assert.equal(spawn.calls.length, 1, 'the loop stops at the first passing candidate');
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].kept, true);
    assert.equal(result.record.derivationHash, result.attempts[0].derivationHash);
  });

  it('rolls a failed candidate back and tries the next one', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const spawn = fakeSpawn([{ status: 1 }, { status: 0 }]);

    const result = runFixLoop({
      task: loopTask({ candidates: TWO_CANDIDATES }),
      root,
      repoState: CLEAN_BRANCH,
      spawn,
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, LOOP_OUTCOMES.APPLIED_TESTED);
    assert.equal(spawn.calls.length, 2);
    // The first candidate's patch did not survive its failed test.
    assert.equal(result.attempts[0].kept, false);
    assert.equal(result.attempts[0].rolledBack, true);
    assert.equal(result.attempts[1].kept, true);
    // The kept candidate is the second one, applied against the base tree.
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
  });

  it('leaves the base tree and refuses when every candidate fails its test', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const spawn = fakeSpawn([{ status: 1 }, { status: 1 }]);

    const result = runFixLoop({
      task: loopTask({ candidates: TWO_CANDIDATES }),
      root,
      repoState: CLEAN_BRANCH,
      spawn,
    });

    assert.equal(result.ok, false);
    assert.equal(result.outcome, LOOP_OUTCOMES.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'ALL_CANDIDATES_EXHAUSTED');
    assert.equal(result.kept.length, 0);
    assert.equal(result.attempts.length, 2);
    // The tree is the base tree: neither candidate's patch survived.
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('treats a gate-blocked test command like a failed test and rolls back', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    const spawn = fakeSpawn([]);

    const result = runFixLoop({
      task: loopTask({ test: { command: 'rm -rf /' } }),
      root,
      repoState: CLEAN_BRANCH,
      spawn,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].test.ran, false);
    assert.equal(result.attempts[0].test.reason, TEST_REFUSALS.GATE_BLOCKED);
    assert.equal(result.attempts[0].rolledBack, true);
    assert.equal(spawn.calls.length, 0, 'a blocked command never runs');
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('runs no process on a dry run and reports the dry-run derivation per candidate', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    const spawn = fakeSpawn([]);

    const result = runFixLoop({
      task: loopTask({ candidates: TWO_CANDIDATES }),
      root,
      repoState: CLEAN_BRANCH,
      dryRun: true,
      spawn,
    });

    assert.equal(spawn.calls.length, 0, 'a dry run tests nothing');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].test.ran, false);
    assert.equal(result.attempts[0].test.reason, 'dry_run');
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('refuses a candidate list over the cap instead of truncating it', () => {
    const candidates = [];
    for (let index = 0; index < 9; index += 1) {
      candidates.push({ type: 'replace_text', path: 'docs/notes.md', find: 'hello v1', replace: `hi v${index}` });
    }

    const result = runFixLoop({
      task: loopTask({ candidates }),
      root: makeRoot(),
      repoState: CLEAN_BRANCH,
      spawn: fakeSpawn([]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, LOOP_REFUSALS.CANDIDATES_OVER_CAP);
    assert.equal(result.attempts.length, 0);
  });

  it('refuses an empty candidate list', () => {
    const result = runFixLoop({
      task: loopTask({ candidates: [] }),
      root: makeRoot(),
      repoState: CLEAN_BRANCH,
      spawn: fakeSpawn([]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, LOOP_REFUSALS.CANDIDATES_INVALID);
  });

  it('stops with ROLLBACK_NOT_VERIFIED when the rollback cannot be verified', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    // Fail the second write: the first is the candidate's apply, the second is
    // the rollback's write-back, which must then fail verification.
    let writes = 0;
    const failingFs = {
      ...fs,
      writeFileSync(target, content, encoding) {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
        return fs.writeFileSync(target, content, encoding);
      },
    };

    const result = runFixLoop({
      task: loopTask(),
      root,
      repoState: CLEAN_BRANCH,
      fs: failingFs,
      spawn: fakeSpawn([{ status: 1 }]),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ROLLBACK_NOT_VERIFIED');
    assert.equal(result.attempts[0].rolledBack, false);
    // The un-rolled-back patch is reported, not hidden.
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
  });

  it('records a refused candidate and continues to the next one', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'v1 and again v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const spawn = fakeSpawn([{ status: 0 }]);

    const result = runFixLoop({
      task: loopTask({
        // The first candidate is ambiguous (two occurrences) and is refused by
        // the transform; the second is unique and applies.
        candidates: [
          { type: 'replace_text', path: 'docs/notes.md', find: 'v1', replace: 'v2' },
          { type: 'replace_text', path: 'docs/notes.md', find: 'v1 and again v1', replace: 'v2' },
        ],
      }),
      root,
      repoState: CLEAN_BRANCH,
      spawn,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].apply.ok, false);
    assert.equal(result.attempts[0].apply.reason, 'TRANSFORM_REFUSED');
    assert.equal(result.attempts[1].kept, true);
  });
});

describe('coder CLI fix-loop wiring', () => {
  it('the production command composition supplies the loop collaborator', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(loopTask()), 'utf8');
    const { createCliCommandHandlers } = require('../lib/coder/cli-composition');
    const handlers = createCliCommandHandlers({});
    const result = handlers.coder(null, [taskFile, '--root', root], { json: true });
    assert.equal(result.data.outcome, LOOP_OUTCOMES.APPLIED_TESTED);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
  });

  it('runs the loop and keeps the patch when the declared test passes', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    write(root, 'test/check.js', 'process.exit(0);\n');
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(loopTask()), 'utf8');

    // --root is how the command names the tree; without it the CLI defaults to
    // process.cwd(), which is not the tree this test set up.
    const result = runCliCoder([taskFile, '--root', root], { json: true, coderLoop });

    assert.equal(result.status, 'completed');
    assert.equal(result.data.outcome, LOOP_OUTCOMES.APPLIED_TESTED);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hi v2\n');
  });

  it('refuses and keeps the tree when the declared test command is blocked', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'greeting: hello v1\n');
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(loopTask({ test: { command: 'rm -rf /' } })), 'utf8');

    const result = runCliCoder([taskFile, '--root', root], { json: true, coderLoop });

    assert.equal(result.status, 'refused');
    assert.equal(result.data.attempts[0].test.reason, TEST_REFUSALS.GATE_BLOCKED);
    assert.equal(read(root, 'docs/notes.md'), 'greeting: hello v1\n');
  });

  it('rejects a malformed test block', () => {
    const root = makeRoot();
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(loopTask({ test: 'node test/check.js' })), 'utf8');

    assert.throws(() => runCliCoder([taskFile, '--root', root], { json: true }), /test/i);
  });
});
