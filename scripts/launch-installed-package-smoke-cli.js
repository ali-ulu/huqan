'use strict';

const { PARITY_CLAIM, PARITY_WORKSPACE, fail, ok, run, packageBin, firstJson, makeSurfaceEnv } = require('./launch-installed-package-smoke-context');
const { validateApprovedReceipt, cliVerifyIsVerified } = require('./launch-smoke-receipts');
const { spawnSync } = require('node:child_process');

/** util-linux `script` gives the CLI a real pty, the way an operator's terminal does. */
function hasScriptPty() {
  if (process.platform !== 'linux') return false;
  return spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// The pty merges stdout and stderr, and typed-ahead input is echoed before
// the prompt, so the JSON line follows the prompt on the same line.
function ptyJson(result, label) {
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      return JSON.parse(line.slice(start));
    } catch (_) {
      // not this line
    }
  }
  fail(`${label} emitted no JSON payload\n${result.output.slice(-2000)}`);
  return null;
}

// Runs `onayla` inside a pty and types the approval id back, as the operator would.
function approveAtTerminal(cliPath, approvalId, consumer, env) {
  const command = [cliPath, 'onayla', approvalId, 'approved', '--json'].map(posixQuote).join(' ');
  return run('script', ['-qec', command, '/dev/null'], { cwd: consumer, env, input: `${approvalId}\n`, timeoutMs: 60 * 1000 });
}

function verifyCliApprovedReceipt(binDir, consumer, baseEnv) {
  const cliPath = packageBin(binDir, 'huqan');
  const env = makeSurfaceEnv(baseEnv, consumer, 'cli-parity');

  const queuedRun = run(cliPath, ['learn:', PARITY_CLAIM, '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  if (queuedRun.status !== 5) {
    fail(`CLI learn-review exited ${queuedRun.status}, expected 5\n${queuedRun.output.slice(-2500)}`);
    return null;
  }
  const queued = firstJson(queuedRun, 'CLI learn-review');
  const approvalId = queued?.approval?.id;
  if (queued?.status !== 'review_required' || typeof approvalId !== 'string' || !approvalId) {
    fail(`CLI learn-review did not expose a durable review approval\n${JSON.stringify(queued).slice(-2500)}`);
    return null;
  }

  const beforeRun = run(cliPath, ['verify:', PARITY_CLAIM, '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  const before = firstJson(beforeRun, 'CLI pre-approval verify');
  if (beforeRun.status !== 0 || cliVerifyIsVerified(before)) {
    fail(`CLI observed the claim as verified before approval\n${beforeRun.output.slice(-2000)}`);
    return null;
  }

  // #3560: deciding an approval needs the operator at a terminal typing the
  // approval id back. Without one -- this spawn's stdin is a pipe -- the
  // installed CLI refuses with exit 4 and decides nothing.
  const refusedRun = run(cliPath, ['onayla', approvalId, 'approved', '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  const stillPending = run(cliPath, ['verify:', PARITY_CLAIM, '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  if (refusedRun.status !== 4 || !/operator_terminal_required/.test(refusedRun.output)
      || cliVerifyIsVerified(firstJson(stillPending, 'CLI verify after a refused approval'))) {
    fail(`CLI decided an approval without the operator's terminal (exit ${refusedRun.status})\n${refusedRun.output.slice(-2500)}`);
    return null;
  }
  ok('CLI refuses an approval without the operator at a terminal and decides nothing');

  if (!hasScriptPty()) {
    // No pty on this runner (Windows): the approval leg needs a terminal, so
    // REST and MCP carry the approved-receipt parity here.
    ok('CLI approval leg skipped: no pty available on this platform');
    return { skipped: true };
  }
  const approvedRun = approveAtTerminal(cliPath, approvalId, consumer, env);
  if (approvedRun.status !== 0) {
    fail(`CLI approval exited ${approvedRun.status}\n${approvedRun.output.slice(-2500)}`);
    return null;
  }
  const decision = ptyJson(approvedRun, 'CLI approval');
  const receipt = decision?.data?.receipt;
  const semantics = validateApprovedReceipt('CLI', receipt, approvalId, decision?.data?.refs, { fail, workspaceId: PARITY_WORKSPACE });
  if (!semantics) return null;

  const afterRun = run(cliPath, ['verify:', PARITY_CLAIM, '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  const after = firstJson(afterRun, 'CLI post-approval verify');
  if (afterRun.status !== 0 || !cliVerifyIsVerified(after)) {
    fail(`CLI approval did not make the claim verifiable\n${afterRun.output.slice(-2000)}`);
    return null;
  }

  const readRun = run(cliPath, ['receipt', receipt.receiptId, '--workspace', PARITY_WORKSPACE, '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  const read = firstJson(readRun, 'CLI receipt read');
  if (readRun.status !== 0 || read?.data?.receipt?.receiptId !== receipt.receiptId
      || read?.data?.receipt?.approvalId !== approvalId) {
    fail(`CLI could not read back its original approved receipt\n${readRun.output.slice(-2500)}`);
    return null;
  }

  ok('CLI performs review -> durable approval -> canonical write -> verify -> original receipt');
  return { approvalId, receipt, semantics };
}

module.exports = { verifyCliApprovedReceipt };
