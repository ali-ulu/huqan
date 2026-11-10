'use strict';

// Real OpenHands host E2E for the `pre_tool_use` gate (#4572).
//
// The guide (docs/automations/openhands.md) marks OpenHands CLI, SDK and Cloud
// as fully integrated and describes HUQAN as a `pre_tool_use` guard. The
// existing test/external-action-hook-cli.test.js only drives HUQAN's own
// projection: it never starts a host, so it cannot prove the host emits the
// documented payload, runs the hook, or suppresses its own executor on a deny.
//
// This file closes that gap for the SDK surface. It installs the gate with the
// repository's own installer, then drives a *real* OpenHands SDK host
// (scripts/openhands-host-e2e/host_driver.py) whose only knowledge of HUQAN is
// the `.openhands/hooks.json` the installer wrote. The host loads that config,
// runs `pre_tool_use`, and partitions the blocked action out before its tool
// runner is reached -- the tool runner appends to a sentinel file, so a
// destructive command that is denied must leave no sentinel line.
//
// Gated by HUQAN_OPENHANDS_E2E=1, the same way the authority install e2e is
// gated by HUQAN_AUTHORITY_E2E. The SDK is a Python dependency the shards do
// not install, so this file must never run there; it is skipped unless the
// workflow opts in. When it does run it skips, rather than fails, if no
// interpreter or SDK is present, so a developer machine without the SDK is not
// turned red.
//
// What it pins, honestly: the host FAILS OPEN on hook timeout, missing command,
// a non-2 non-zero exit and malformed/empty output; it blocks only on exit 2 or
// a top-level `deny` decision. That is the host's contract, not a bug in this
// repository, and the acceptance criteria in #4572 assume the opposite. The
// test records the real behaviour so the guide can be corrected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(REPO_ROOT, 'scripts', 'openhands-host-e2e', 'host_driver.py');
const GATE_HOOK = path.join(REPO_ROOT, 'bin', 'huqan-gate-hook.js');

const ENABLED = process.env.HUQAN_OPENHANDS_E2E === '1';

// The gate blocks unattested calls by default (#2505). Identity binding is its
// own surface (test/external-action-identity.test.js); this file is about the
// host boundary, so it opts out exactly the way test/external-action-hook-cli.js
// does, and the deny/allow it observes is the policy decision, not the card check.
const GUARD_ENV = Object.freeze({
  HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: 'allow',
  HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: 'allow',
});

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  return null;
}

function sdkAvailable(python) {
  const probe = spawnSync(python.command, [...python.prefix, '-c', 'import openhands.sdk'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-openhands-e2e-'));
}

/** Install the gate the way the guide says an operator does. */
function installGate(root) {
  const { manageGate } = require('../lib/external-action-gate-install');
  // The installer proves the artifact with a live sentinel subprocess, which
  // inherits this process's environment -- so the identity opt-out has to be on
  // process.env for the duration, not only in the options object. Restored
  // afterwards so the choice does not leak into a later test in the same run.
  const saved = {};
  for (const [key, value] of Object.entries(GUARD_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return manageGate('install', { profile: 'openhands', root, home: root, deploymentAuthorized: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Drive the real host over a list of actions; return its structured report. */
function runHost(python, root, actions, { receipts, sessionId = 'e2e-session' } = {}) {
  const sentinel = path.join(root, 'sentinel.ndjson');
  const request = JSON.stringify({ session_id: sessionId, actions });
  const run = spawnSync(python.command, [...python.prefix, DRIVER, root, sentinel], {
    cwd: root,
    input: request,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GUARD_ENV,
      HUQAN_EXTERNAL_GUARD_RECEIPTS: receipts,
      OPENHANDS_SUPPRESS_BANNER: '1',
    },
  });
  assert.equal(run.status, 0, `host driver failed: ${run.stderr}`);
  const executed = fs.existsSync(sentinel)
    ? fs.readFileSync(sentinel, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { report: JSON.parse(run.stdout), executed, sentinel };
}

function receiptLines(receipts) {
  if (!fs.existsSync(receipts)) return [];
  return fs.readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Append one correlation record to the CI artifact the workflow uploads.
 *
 * The acceptance criteria in #4572 ask for the host invocation, the decision
 * and the receipt to be correlated in an artifact, not just asserted in-process.
 * `HUQAN_OPENHANDS_E2E_REPORT` names that file; with no value set the run stays
 * quiet, so a local run leaves nothing behind.
 */
function record(report, entry) {
  const target = process.env.HUQAN_OPENHANDS_E2E_REPORT;
  if (!target) return;
  fs.appendFileSync(target, `${JSON.stringify({ ...report, ...entry })}\n`);
}

/** Write a minimal hooks.json whose single hook is the given command. */
function writeRawHooks(root, command, timeout = 30) {
  fs.mkdirSync(path.join(root, '.openhands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.openhands', 'hooks.json'), JSON.stringify({
    hooks: {
      pre_tool_use: [{ matcher: '*', hooks: [{ type: 'command', command, commandWindows: command, timeout }] }],
    },
  }, null, 2));
}

const python = ENABLED ? findPython() : null;
/** node:test only skips when the option is present and truthy. */
function skipOptions() {
  return SKIP ? { skip: SKIP } : {};
}

const SKIP = !ENABLED
  ? 'set HUQAN_OPENHANDS_E2E=1 to run the real OpenHands host e2e'
  : !python
    ? 'no python interpreter available'
    : !sdkAvailable(python)
      ? 'openhands-sdk is not installed in the interpreter on PATH'
      : null;

test('a real OpenHands host invokes the gate and honors its decision (#4572)', skipOptions(), () => {
  const root = tempWorkspace();
  const receipts = path.join(root, 'receipts.jsonl');

  const installed = installGate(root);
  assert.equal(installed.installed, true);
  assert.equal(installed.target, path.join(root, '.openhands', 'hooks.json'));
  // The installer's own sentinel already proved the artifact blocks through the
  // host's contract; the host run below is the independent confirmation.
  assert.equal(installed.sentinel.live, true);

  const { report, executed } = runHost(python, root, [
    { tool_name: 'terminal', tool_input: { command: 'git status' } },
    { tool_name: 'terminal', tool_input: { command: 'git remote add origin https://example.invalid/repo' } },
    { tool_name: 'terminal', tool_input: { command: 'rm -rf /' } },
  ], { receipts });

  assert.match(report.openhands_sdk_version, /^\d+\.\d+\.\d+/);
  const [read, review, destroy] = report.results;

  // A safe read reaches the executor and produces the allow response.
  assert.equal(read.blocked, false);
  assert.equal(read.executed, true);
  assert.equal(read.hooks[0].exit_code, 0);
  assert.deepEqual(JSON.parse(read.hooks[0].stdout), {});

  // `review` has no OpenHands decision, so the gate projects it as deny; the
  // host blocks it and the reason still says it is a pending human decision.
  assert.equal(review.blocked, true);
  assert.equal(review.executed, false);
  assert.match(review.reason, /review required/i);
  assert.match(review.reason, /human decision pending/i);

  // A denylisted command is denied before the executor.
  assert.equal(destroy.blocked, true);
  assert.equal(destroy.executed, false);
  assert.match(destroy.reason, /DENYLISTED_COMMAND_BLOCKED/);
  assert.equal(JSON.parse(destroy.hooks[0].stdout).decision, 'deny');

  // The side-effect sentinel proves the executor never ran the destructive call.
  assert.deepEqual(executed.map((entry) => entry.tool_name), ['terminal']);
  assert.equal(executed.length, 1);

  // The deny correlates a receipt id in the hook reason with the receipt trail.
  // The gate's own vocabulary is allow/review/block; only the *host* projection
  // is allow/deny, so the trail records `block`, not `deny`.
  const receiptId = /xact_adm_[0-9a-f]+/.exec(destroy.reason);
  assert.ok(receiptId, `no receipt id in reason: ${destroy.reason}`);
  const lines = receiptLines(receipts);
  assert.ok(lines.length >= 2, 'expected admission receipts for allow and deny');
  assert.ok(lines.some((line) => line.receiptId === receiptId[0]), 'deny receipt not found in the trail');
  assert.ok(lines.some((line) => line.decision === 'block'), 'no block receipt recorded');
  assert.ok(lines.some((line) => line.decision === 'allow'), 'no allow receipt recorded');

  record({ sdk: report.openhands_sdk_version }, {
    case: 'host-boundary',
    safe_read: { blocked: read.blocked, executed: read.executed },
    review_projection: { blocked: review.blocked, reason: review.reason },
    deny: { blocked: destroy.blocked, executed: destroy.executed, receipt_id: receiptId[0] },
    receipts: lines.map((line) => ({ receiptId: line.receiptId, decision: line.decision })),
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('the OpenHands host fails open on timeout, crash, and malformed output (#4572)', skipOptions(), () => {
  // Each case is a workspace whose hooks.json points at a command that is not
  // HUQAN's. The host's contract (openhands/sdk/hooks/executor.py) blocks only
  // on exit 2 or a top-level `deny`; every other failure is allowed through.
  // This is the boundary the guide must describe, so the test records it
  // explicitly instead of assuming a fail-closed host.
  const cases = [
    { name: 'timeout', command: 'sleep 5', timeout: 1, blocked: false, exit: -1 },
    { name: 'crash', command: 'exit 1', timeout: 30, blocked: false, exit: 1 },
    { name: 'malformed', command: 'echo not-json', timeout: 30, blocked: false, exit: 0 },
    { name: 'not-found', command: 'huqan-gate-definitely-missing --profile openhands', timeout: 30, blocked: false, exit: 127 },
    { name: 'exit-2', command: 'exit 2', timeout: 30, blocked: true, exit: 2 },
  ];

  for (const scenario of cases) {
    const root = tempWorkspace();
    writeRawHooks(root, scenario.command, scenario.timeout);
    const { report, executed } = runHost(python, root, [
      { tool_name: 'terminal', tool_input: { command: 'rm -rf /' } },
    ], { receipts: path.join(root, 'receipts.jsonl') });

    const result = report.results[0];
    assert.equal(result.blocked, scenario.blocked, `${scenario.name}: blocked mismatch`);
    assert.equal(result.executed, !scenario.blocked, `${scenario.name}: executor suppression mismatch`);
    assert.equal(result.hooks[0].exit_code, scenario.exit, `${scenario.name}: exit code mismatch`);
    assert.equal(executed.length, scenario.blocked ? 0 : 1, `${scenario.name}: sentinel mismatch`);
    record({ sdk: report.openhands_sdk_version }, {
      case: 'host-failure-boundary',
      scenario: scenario.name,
      blocked: result.blocked,
      executed: result.executed,
      exit_code: result.hooks[0].exit_code,
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HUQAN\'s own hook fails closed on an unreadable payload (#4572)', skipOptions(), () => {
  // The host fails open, so the fail-closed guarantee has to come from HUQAN:
  // an input it cannot parse must exit 2, which is the one code the host treats
  // as a block. This is what keeps a broken host payload from silently
  // disarming the gate.
  const root = tempWorkspace();
  const run = spawnSync(process.execPath, [
    GATE_HOOK,
    '--profile', 'openhands',
    '--workspace-root', REPO_ROOT,
    '--receipt-log', path.join(root, 'receipts.jsonl'),
    '--memory-path', path.join(root, 'memory.json'),
    '--db-path', path.join(root, 'memory.db'),
  ], { cwd: REPO_ROOT, input: 'not-json', encoding: 'utf8', env: { ...process.env, ...GUARD_ENV } });

  assert.equal(run.status, 2, `expected exit 2 on unreadable input, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /fail(ed)? closed/i);
  fs.rmSync(root, { recursive: true, force: true });
});
