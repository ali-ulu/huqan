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
 *   No shell. The command is tokenized on whitespace and spawned directly.
 *   A command that needs shell features (pipes, `&&`) is exactly the shape the
 *   gate REVIEWs, so refusing REVIEW and shelling out would be the same
 *   refusal wearing two hats; without a shell there is also no injection
 *   surface left to argue about. The practical consequence is that a declared
 *   test command must be a directly executable program — `node --test ...`,
 *   the same shape the repository's own scripts use — and a `.cmd`/`.bat`
 *   wrapper will not resolve without a shell.
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
});

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

  const timedOut = outcome.signal === 'SIGTERM'
    || (outcome.error && outcome.error.code === 'ETIMEDOUT');
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
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  OUTPUT_TAIL_CHARS,
  TEST_REFUSALS,
  runDeclaredTest,
};
