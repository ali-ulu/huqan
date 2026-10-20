#!/usr/bin/env node
'use strict';

// #4088: an ambiguous check-run network outcome leaves a Streaming Trust
// writeback durably 'started', and automatic replay refuses a second write by
// design. This is the operator's way out: read what GitHub actually has for
// the delivery's deterministic external id, complete the local record from it,
// and never write a second check unless the operator explicitly confirms it.

const fs = require('node:fs');

const { createStreamingTrustAccessToken } = require('../lib/github-app-streaming-auth');
const { canonicalInstantFromMs } = require('../lib/github-app-streaming-trust-binding');
const { writeCheckRun } = require('../lib/github-app-streaming-trust-check-run');
const { CHECK_NAME, ERROR_CODES, GITHUB_API_BASE } = require('../lib/github-app-streaming-trust-contract');
const { apiHeaders, fetchJson, repositoryParts } = require('../lib/github-app-streaming-trust-github-api');
const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');

async function reconcileGitHubAppWriteback({
  deliveryId,
  rootPath,
  appId,
  privateKey,
  fetchImpl = globalThis.fetch,
  confirm = false,
  nowMs = Date.now(),
  write = (text) => process.stdout.write(text),
}) {
  const store = createGitHubAppStreamingTrustStore({ rootPath });
  const writeback = store.readWriteback(deliveryId);
  if (writeback.state === 'none') {
    write(`no writeback record for ${deliveryId}; nothing to reconcile\n`);
    return { status: 'absent' };
  }
  if (writeback.state === 'complete') {
    write(`writeback for ${deliveryId} is already complete (check run ${writeback.checkRunId})\n`);
    return { status: 'complete', checkRunId: writeback.checkRunId };
  }

  const { binding, receiptHash, externalId } = writeback;
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const access = await createStreamingTrustAccessToken({
    appId,
    privateKey,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    fetchImpl,
    nowMs,
  });
  // The token must never reach an operator terminal, whatever happens below.
  const redact = (text) => text.split(access.token).join('<redacted>');

  const listing = await fetchJson(
    fetchImpl,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${binding.headSha}/check-runs`
      + `?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
    { method: 'GET', headers: apiHeaders(access.token) },
    ERROR_CODES.CHECK_LIST_FAILED,
  );
  const matches = (Array.isArray(listing && listing.check_runs) ? listing.check_runs : [])
    .filter((run) => run && run.external_id === externalId && Number.isSafeInteger(run.id) && run.id > 0);

  if (matches.length > 0) {
    // A duplicate external id can only mean a check was written more than
    // once; committing against the newest is deterministic and touches nothing.
    const checkRunId = Math.max(...matches.map((run) => run.id));
    const completed = store.commitWriteback({
      binding, receiptHash, externalId, checkRunId,
      completedAt: canonicalInstantFromMs(nowMs),
    });
    write(redact(`reconciled ${deliveryId}: committed GitHub check run ${checkRunId} (state: ${completed.state})\n`));
    return { status: 'committed', checkRunId };
  }

  if (!confirm) {
    write(`GitHub has no ${CHECK_NAME} check with external id ${externalId} for ${deliveryId}.\n`);
    write('re-run with --confirm to write the check exactly once\n');
    return { status: 'needs-confirmation' };
  }

  // GitHub never received the write. Rewriting it is a second write, so it
  // stays behind this explicit confirmation exactly like the automatic replay
  // refuses one -- that refusal is the point of the durable store.
  const evaluation = store.readEvaluation(deliveryId);
  if (!evaluation) {
    throw new Error(`no stored evaluation for ${deliveryId}; the check body cannot be rebuilt`);
  }
  const written = await writeCheckRun({
    binding,
    receipt: evaluation.receipt,
    externalId,
    token: access.token,
    fetchImpl,
  });
  const completed = store.commitWriteback({
    binding, receiptHash, externalId,
    checkRunId: written.checkRunId,
    completedAt: canonicalInstantFromMs(nowMs),
  });
  write(redact(`reconciled ${deliveryId}: wrote check run ${written.checkRunId} with confirmation (state: ${completed.state})\n`));
  return { status: 'rewritten', checkRunId: written.checkRunId };
}

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write([
      'usage: node scripts/github-app-reconcile-writeback.js <deliveryId> [--root <path>] [--confirm]',
      '',
      "Completes a Streaming Trust writeback that an ambiguous network outcome left in the 'started' state.",
      "If GitHub already has the delivery's check run, the local record is completed from it.",
      'If it does not, a rewrite happens only with --confirm.',
      '',
      'credentials: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH',
      'store root: --root, or GITHUB_APP_STORE_PATH when omitted',
    ].join('\n') + '\n');
    return 0;
  }
  const deliveryId = args.find((arg) => !arg.startsWith('--'));
  const rootPath = readFlag(args, '--root') || process.env.GITHUB_APP_STORE_PATH;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const appId = process.env.GITHUB_APP_ID;
  if (!deliveryId) throw new Error('a delivery id is required');
  if (!rootPath) throw new Error('a store root is required: pass --root or set GITHUB_APP_STORE_PATH');
  if (!appId || !privateKeyPath) {
    throw new Error('credentials are required: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH');
  }
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const result = await reconcileGitHubAppWriteback({ deliveryId, rootPath, appId, privateKey });
  return result.status === 'needs-confirmation' ? 2 : 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`reconcile failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { reconcileGitHubAppWriteback };
