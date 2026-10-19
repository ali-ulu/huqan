'use strict';

/**
 * HUQAN Coder — the test step of the fix loop.
 *
 * The coder core never spawns a process: applyDerivation's contract is
 * read -> runTask -> gate -> write, and every module under lib/coder/ keeps
 * that. This module is the loop's process layer, and the only one: it runs the
 * command a task's declared `test` block names and reports what it observed.
 * It decides nothing about the patch — the loop does that — and the gate still
 * governs the command itself.
 *
 * Three bounds, all fail-closed:
 *
 *   Gate first. The literal command text is evaluated by the command-exec gate
 *   (AB8) before anything runs. A denylisted command or an out-of-workspace
 *   redirection target is BLOCK and a shell-injection pattern is REVIEW; both
 *   refuse the run here. This module has no authority to release either, so a
 *   caller that wants its test run must declare a command the gate allows.
 *
 *   No shell. The command is tokenized on whitespace and spawned directly,
 *   and the program it would start is checked against a declared list of test
 *   executables before it runs. Tokenizing alone is not a shell boundary: `sh`
 *   is a program like any other, and `sh -c "..."` in the first position runs
 *   the real shell, with the shell grammar the gate refuses, under the coder
 *   identity (#4073). A command that needs shell features (pipes, `&&`) is
 *   exactly the shape the gate REVIEWs, so refusing REVIEW and shelling out
 *   would be the same refusal wearing two hats. The practical consequence is
 *   that a declared test command must name a declared test executable —
 *   `node --test ...`, the same shape the repository's own scripts use — and a
 *   `.cmd`/`.bat` wrapper will not resolve without a shell.
 *
 *   Bounded execution. The run carries a timeout (default 120s, capped) and an
 *   output cap (1 MiB). A run that exceeds either is a failed test with its
 *   reason named, never an unbounded wait or an unbounded buffer.
 *
 * A command that cannot start at all is reported as a failed run with its
 * reason rather than retried: the loop records it, rolls the candidate's patch
 * back, and the human sees which command the task asked for.
 */

const { spawnSync } = require('node:child_process');

const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('../command-exec-gate');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4000;

const TEST_REFUSALS = Object.freeze({
  TEST_BLOCK_INVALID: 'TEST_BLOCK_INVALID',
  COMMAND_NOT_DECLARED: 'COMMAND_NOT_DECLARED',
  GATE_BLOCKED: 'GATE_BLOCKED',
  GATE_REVIEW: 'GATE_REVIEW',
  TEST_EXECUTABLE_IS_INTERPRETER: 'TEST_EXECUTABLE_IS_INTERPRETER',
  TEST_EXECUTABLE_NOT_ALLOWED: 'TEST_EXECUTABLE_NOT_ALLOWED',
  TEST_COMMAND_INLINE_CODE: 'TEST_COMMAND_INLINE_CODE',
});

/**
 * The programs a declared test command may name as argv[0].
 *
 * Every test command this product declares is `node --test ...`: the project
 * producer, the two project verifications and the fix loop's own tasks all
 * name node, and this module has always required a declared test to be a
 * directly executable program.
 *
 * The list is short on purpose. A task file is caller supplied
 * (`huqan coder <task.json>`), so argv[0] is a string the caller chose, and
 * #4073 is what that string could do. The comparison is on the exact string:
 * a path that merely ends in an allowed name (`C:\temp\node.exe`) is some
 * other program, and a file name is not evidence of which one it is. Naming
 * a different runtime is a deliberate change to this list, reviewed like any
 * other, not something a task file opts into.
 */
const ALLOWED_TEST_EXECUTABLES = Object.freeze(['node']);

/**
 * Programs that interpret a command string.
 *
 * Refused outright and named apart from the allowlist, so the refusal says
 * why: a shell carries the metacharacter grammar the gate already refuses
 * (pipes, `&&`, redirection) with it, which is the whole point of the "no
 * shell" bound above. The comparison is on the file name, and only to choose
 * the reason -- nothing is allowed on the strength of it.
 */
const SHELL_INTERPRETERS = Object.freeze([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'csh', 'tcsh', 'fish', 'ash',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wscript', 'wscript.exe', 'cscript', 'cscript.exe', 'mshta', 'mshta.exe',
]);

/**
 * Flags that make an allowed executable evaluate a string as code
 * (`node -e "..."`, `node --eval=...`).
 *
 * The same hole as the interpreter, one layer down: the text is the
 * caller's, and it runs before a test file is ever read. An allowlist that
 * stopped at the program name would let the caller reach a shell from the
 * allowed program instead.
 */
const INLINE_CODE_FLAG = /^-[ep]/;
const INLINE_CODE_LONG_FLAG = /^--(eval|print)(=|$)/;

/** The file name of an executable path, for naming a refusal only. */
function executableName(raw) {
  return String(raw || '').split(/[\\/]/).pop().toLowerCase();
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_TIMEOUT_MS));
}

/**
 * Bounded evidence: the tail of the combined output, capped, so a chatty test
 * suite cannot turn a derivation-sized record into a megabyte one. The cap is
 * stated in the field's contract the same way the receipt exporter's is.
 */
function outputTail(stdout, stderr) {
  const combined = `${stdout || ''}${stderr || ''}`;
  if (combined.length <= OUTPUT_TAIL_CHARS) return combined;
  return `...${combined.slice(-OUTPUT_TAIL_CHARS)}`;
}

function notRan(reason, extra = {}) {
  return { ran: false, ok: null, reason, outputTail: '', ...extra };
}

/**
 * Run one declared test command and report what was observed.
 *
 * Note which party reports the outcome. The gate does not run the command and
 * this module does not apply its own verdict: the decision gates the run, and
 * `ok` is the observed exit status — a timeout, an output cap and a non-zero
 * exit are all failures with their reason named, not a generic "failed".
 * Whoever decides must not also be the only one who records the decision.
 */
function runDeclaredTest({ test, root, spawn = null } = {}) {
  if (!test || typeof test !== 'object' || Array.isArray(test)) {
    return notRan(TEST_REFUSALS.TEST_BLOCK_INVALID);
  }
  const command = typeof test.command === 'string' ? test.command.trim() : '';
  if (!command) return notRan(TEST_REFUSALS.COMMAND_NOT_DECLARED);

  const gate = evaluateCommandExec({ command, workspaceRoot: root });
  if (gate.decision === COMMAND_EXEC_DECISIONS.BLOCK) {
    return notRan(TEST_REFUSALS.GATE_BLOCKED, { gateReason: gate.reason, command });
  }
  if (gate.decision !== COMMAND_EXEC_DECISIONS.ALLOW) {
    // REVIEW included, deliberately: a shell-injection pattern is refused
    // here, not executed. Releasing a REVIEW is an operator decision this
    // module does not carry.
    return notRan(TEST_REFUSALS.GATE_REVIEW, { gateReason: gate.reason, command });
  }

  const tokens = command.split(/\s+/u).filter(Boolean);

  // The gate has read the command as text. What it cannot see is which
  // program that text will start, and that program is the caller's to
  // choose: `sh -c "..."` passes the gate as a benign command and still runs
  // the real shell. So the executable is checked here, where the spawn
  // actually happens, and the gate's verdict and the executor's answer
  // cannot disagree about which program may run.
  const executable = tokens[0];
  if (SHELL_INTERPRETERS.includes(executableName(executable))) {
    return notRan(TEST_REFUSALS.TEST_EXECUTABLE_IS_INTERPRETER, { command, executable });
  }
  if (!ALLOWED_TEST_EXECUTABLES.includes(executable)) {
    return notRan(TEST_REFUSALS.TEST_EXECUTABLE_NOT_ALLOWED, { command, executable });
  }
  const inlineCode = tokens.find((token) => INLINE_CODE_FLAG.test(token) || INLINE_CODE_LONG_FLAG.test(token));
  if (inlineCode) {
    return notRan(TEST_REFUSALS.TEST_COMMAND_INLINE_CODE, { command, executable, flag: inlineCode });
  }

  const startedAt = Date.now();
  let outcome;
  try {
    outcome = (spawn || spawnSync)(tokens[0], tokens.slice(1), {
      cwd: root,
      timeout: boundedTimeout(test.timeoutMs),
      killSignal: 'SIGTERM',
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return {
      ran: true,
      ok: false,
      command,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      reason: 'TEST_SPAWN_FAILED',
      outputTail: outputTail('', error && error.message),
    };
  }

  const timedOut = Boolean(outcome.error && outcome.error.code === 'ETIMEDOUT');
  const outputCapped = Boolean(outcome.error && outcome.error.code === 'ENOBUFS');
  return {
    ran: true,
    ok: !timedOut && !outputCapped && outcome.status === 0,
    command,
    exitCode: outcome.status,
    signal: outcome.signal || null,
    durationMs: Date.now() - startedAt,
    reason: timedOut
      ? 'TEST_TIMEOUT'
      : outputCapped
        ? 'OUTPUT_LIMIT_EXCEEDED'
        : (outcome.status === 0 ? null : 'TEST_FAILED'),
    outputTail: outputTail(outcome.stdout, outcome.stderr),
  };
}

module.exports = {
  ALLOWED_TEST_EXECUTABLES,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  OUTPUT_TAIL_CHARS,
  SHELL_INTERPRETERS,
  TEST_REFUSALS,
  runDeclaredTest,
};
