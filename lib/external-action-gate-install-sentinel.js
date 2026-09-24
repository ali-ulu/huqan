'use strict';
// #2145: the synthetic `rm -rf /` sentinel and the machinery that drives it
// through a hook command under every host shell, in a throwaway directory so
// the deployment's evidence trail never records a block that did not happen.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateHookInvocation } = require('./external-action-adapter');
const { fail } = require('./external-action-gate-install-spec');
const SENTINEL_TIMEOUT_MS = 30000;

function sentinelPayload(profile, root) {
  const base = { session_id: 'huqan-install-sentinel', tool_use_id: 'huqan-install-sentinel', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'opencode') return { sessionID: base.session_id, callID: base.tool_use_id, tool: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  // Pi nests the call under `event` and names the fields in camelCase (see
  // normalizeHookInvocation). The flat snake_case payload this used to send
  // normalized to `toolName: undefined`, so the sentinel blocked -- but as
  // `malformed_external_action_blocked`, proving the malformed-input path
  // rather than the denylist it was written to prove.
  if (profile === 'pi') {
    return { event: { toolCallId: base.tool_use_id, toolName: 'bash', input: { command: 'rm -rf /' } }, sessionId: base.session_id, cwd: root };
  }
  if (profile === 'hermes') return { session_id: base.session_id, tool_call_id: base.tool_use_id, tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  return base;
}
function wrote(receiptPath) {
  return fs.existsSync(receiptPath) && fs.readFileSync(receiptPath, 'utf8').trim() !== '';
}
/**
 * Everything the sentinel run persists goes to a throwaway directory: the JSONL
 * trail and, for the CLI path, the graph the durable writer opens. The legacy
 * AXIOM_* twins are dropped because the guard refuses to start when a variable
 * and its twin disagree, and here they would.
 */
function withSentinelScratch(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-sentinel-'));
  const receiptPath = path.join(scratch, 'receipts.jsonl');
  const environment = {
    ...process.env,
    HUQAN_EXTERNAL_GUARD_RECEIPTS: receiptPath,
    HUQAN_MEMORY_PATH: path.join(scratch, 'memory.json'),
    HUQAN_DB_PATH: path.join(scratch, 'memory.db'),
  };
  delete environment.AXIOM_MEMORY_PATH;
  delete environment.AXIOM_DB_PATH;
  try {
    return run(environment, receiptPath);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The shells a host may hand a hook command to. Validating under only one of
 * them is how a command that cmd.exe runs happily was recorded for a host that
 * uses PowerShell, where the same string is a parser error (#1797): the
 * install proved the command against the wrong interpreter and called it live.
 */
const HOST_SHELLS = Object.freeze(process.platform === 'win32'
  ? [
    { name: 'cmd', file: process.env.ComSpec || 'cmd.exe', argv: command => ['/d', '/s', '/c', command] },
    { name: 'powershell', file: 'powershell.exe', argv: command => ['-NoProfile', '-NonInteractive', '-Command', command] },
  ]
  : [{ name: 'sh', file: '/bin/sh', argv: command => ['-c', command] }]);

const HOOK_DECISIONS = Object.freeze({ deny: 'block', ask: 'review' });

/** A shell that is not installed cannot be a host's shell; skip, do not fail. */
function shellMissing(run) {
  return Boolean(run.error) && ['ENOENT', 'EACCES'].includes(run.error.code);
}

function runHookCommand(shell, command, payload, root, env) {
  const run = spawnSync(shell.file, shell.argv(command), {
    input: JSON.stringify(payload), cwd: root, encoding: 'utf8', timeout: SENTINEL_TIMEOUT_MS, env,
  });
  if (shellMissing(run)) return null;
  if (run.error) fail(`hook command could not be run under ${shell.name} (${command}): ${run.error.message}`);
  if (run.status !== 0) fail(`hook command failed under ${shell.name} (${command}): exit ${run.status}: ${(run.stderr || '').trim()}`);
  let output;
  try { output = JSON.parse(run.stdout || '{}'); } catch (_) {
    fail(`hook command returned no JSON decision under ${shell.name} (${command}): ${(run.stdout || run.stderr || '').trim()}`);
  }
  const specific = output.hookSpecificOutput || {};
  return {
    decision: output.action === 'block' ? 'block' : HOOK_DECISIONS[specific.permissionDecision] || 'allow',
    reason: specific.permissionDecisionReason || output.message || '',
  };
}

/**
 * Run a command through every shell available here, and say which ones were
 * used -- a claim about a hook is only worth the interpreters it was tested
 * against.
 */
function exerciseCommand(command, payload, root) {
  return withSentinelScratch((env, receiptPath) => {
    const shells = [];
    for (const shell of HOST_SHELLS) {
      const outcome = runHookCommand(shell, command, payload, root, env);
      if (outcome) shells.push({ ...outcome, shell: shell.name });
    }
    if (!shells.length) fail(`no host shell available to validate the hook command: ${command}`);
    return { command, shells, receiptWritten: wrote(receiptPath) };
  });
}

/**
 * Whether a candidate starts the way Hermes starts it: as an argv, with no
 * shell in front of it (`subprocess.run(argv, shell=False)` in
 * adapters/external-action/hermes/__init__.py).
 *
 * A shell is not a neutral wrapper for this question. On Windows, cmd.exe and
 * PowerShell resolve a bare `huqan-gate` through PATHEXT and find the `.cmd`
 * shim, so the candidate passes `exerciseCommand` -- while the same name
 * handed to CreateProcess fails with WinError 2, because npm's extensionless
 * shim is a `#!/bin/sh` script Windows cannot execute. The install then
 * recorded a command Hermes could not start, and every guarded call blocked as
 * "HUQAN guard failed" instead of on policy: fail-closed, so it looked safe,
 * while the denylist was never consulted. #1797 is the same defect one axis
 * over -- a command proved against the wrong interpreter -- so this is checked
 * by running it, not by special-casing a platform.
 */
function startsWithoutShell(invocation, payload, root) {
  const argv = invocation.split(' ');
  return withSentinelScratch((env) => {
    const run = spawnSync(argv[0], argv.slice(1), {
      input: JSON.stringify(payload), cwd: root, encoding: 'utf8', timeout: SENTINEL_TIMEOUT_MS, env, shell: false,
    });
    if (run.error || run.status !== 0) return false;
    try {
      return JSON.parse(run.stdout || '{}').action === 'block';
    } catch (_) {
      return false;
    }
  });
}

function evaluatorExpectation(profile, root, payload = sentinelPayload(profile, root)) {
  const evaluated = evaluateHookInvocation(profile, payload, { workspaceRoot: root, allowControlPlane: true });
  if (evaluated.result.decision !== 'block') fail(`sentinel did not block for profile ${profile}: ${evaluated.result.decision}`);
  return { decision: evaluated.result.decision, reason: evaluated.result.reason };
}

function exerciseBrowserOutcome(command, root) {
  const { normalizeHookInvocation } = require('./external-action-adapter');
  const { normalizeExternalActionEnvelope } = require('./external-action-envelope');
  const { buildExternalActionAdmissionReceipt } = require('./external-action-receipt');
  return withSentinelScratch((env, receiptPath) => {
    let tested = 0;
    for (const shell of HOST_SHELLS) {
      const payload = { hook_event_name: 'PostToolUse', tool_use_id: `browser-sentinel-${shell.name}`,
        session_id: 'browser-sentinel', tool_name: 'browser_navigate',
        tool_input: { url: 'https://example.invalid/sentinel' }, cwd: root };
      const envelope = normalizeExternalActionEnvelope(normalizeHookInvocation('claude-code', payload));
      const admission = buildExternalActionAdmissionReceipt(envelope, { decision: 'allow', reason: 'synthetic_sentinel', findings: [] });
      fs.appendFileSync(receiptPath, JSON.stringify(admission) + '\n');
      const result = runHookCommand(shell, `${command} browser-outcome --profile claude-code`, payload, root, env);
      if (!result) continue;
      const receipts = fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
      if (!receipts.some(receipt => receipt.receiptKind === 'external_action_outcome_receipt'
        && receipt.metadata?.admissionReceiptId === admission.receiptId && receipt.metadata.outcomeStatus === 'executed')) {
        fail(`browser outcome command produced no outcome receipt under ${shell.name}`);
      }
      tested += 1;
    }
    if (!tested) fail('no host shell available for browser outcome validation');
  });
}

module.exports = Object.freeze({
  SENTINEL_TIMEOUT_MS, sentinelPayload, wrote, withSentinelScratch, exerciseCommand,
  startsWithoutShell, evaluatorExpectation, exerciseBrowserOutcome,
});
