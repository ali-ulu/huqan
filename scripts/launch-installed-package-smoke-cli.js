'use strict';

const { PARITY_CLAIM, PARITY_WORKSPACE, fail, ok, run, packageBin, firstJson, makeSurfaceEnv } = require('./launch-installed-package-smoke-context');
const { validateApprovedReceipt, cliVerifyIsVerified } = require('./launch-smoke-receipts');

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

  const approvedRun = run(cliPath, ['onayla', approvalId, 'approved', '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  if (approvedRun.status !== 0) {
    fail(`CLI approval exited ${approvedRun.status}\n${approvedRun.output.slice(-2500)}`);
    return null;
  }
  const decision = firstJson(approvedRun, 'CLI approval');
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
