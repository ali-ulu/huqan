#!/usr/bin/env node
'use strict';

// #4088 (ENT-TL5): an operator tool for a Streaming Trust writeback that is
// stuck in the ambiguous `started` state.
//
// The writeback stage reserves a record, writes the check run, and only then
// commits the record as complete. When the write has no clear network outcome
// -- the connection drops after GitHub already accepted the check run -- the
// record stays `started`, and every redelivery is refused with
// GITHUB_APP_STREAMING_WRITEBACK_STATE_UNKNOWN. That refusal is right: a
// replay must not write a second check. But it leaves the delivery ambiguous
// with no way out, and a pull request that never shows a HUQAN check looks
// exactly like a pull request the gate never ran on.
//
// So an operator reconciles it, and only an operator can:
//
//   1. read the stored writeback and the evaluation it belongs to;
//   2. recompute the external id, which is derived from the delivery and the
//      receipt hash and is therefore deterministic, and refuse to touch a
//      record that does not reproduce it;
//   3. read the commit's check runs and look for the one carrying that exact
//      external id -- if it is there, the write did land, and the record is
//      committed as complete without writing anything;
//   4. only if GitHub holds no such check, and only when the operator asked
//      for it explicitly, write the check once.
//
// There is no automatic write. The installation token keeps the scope the C8
// loop already uses, and it never reaches the output.

const { readCompatibleEnvironmentVariable } = require('../lib/environment-compat');
const { isPlainObject } = require('../lib/is-plain-object');
const {
  GITHUB_APP_STORE_PATH_ENV,
  readStreamingTrustConfig,
} = require('../lib/github-app-beta-http-config');
const { createStreamingTrustAccessToken } = require('../lib/github-app-streaming-auth');
const { canonicalInstantFromMs, positiveSafeInteger } = require('../lib/github-app-streaming-trust-binding');
const { writeCheckRun } = require('../lib/github-app-streaming-trust-check-run');
const { checkExternalId } = require('../lib/github-app-streaming-trust-receipt');
const { CHECK_NAME, ERROR_CODES, GITHUB_API_BASE, fail } = require('../lib/github-app-streaming-trust-contract');
const { apiHeaders, fetchJson, repositoryParts } = require('../lib/github-app-streaming-trust-github-api');

// A check-run list filtered by check name is a handful of entries; the bound
// is there so a malformed answer cannot make this tool walk an unbounded
// response.
const MAX_CHECK_RUNS = 100;
const READ_TIMEOUT_MS = 30_000;

const OUTCOMES = Object.freeze({
  // GitHub already holds the check: the record is closed, nothing is written.
  RECONCILED: 'reconciled',
  // GitHub holds no such check and the operator did not confirm a rewrite.
  CHECK_ABSENT: 'check-absent',
  // GitHub held no such check and the operator confirmed one rewrite.
  REWRITTEN: 'rewritten',
  // The record was already complete; there was nothing to reconcile.
  ALREADY_COMPLETE: 'already-complete',
});

const USAGE = [
  'usage: node scripts/github-app-reconcile-writeback.js --delivery <delivery-id> [--confirm-rewrite]',
  '',
  'Reconciles a Streaming Trust writeback that is stuck in the ambiguous `started` state.',
  '',
  'The deployment is read from the same environment the GitHub App service reads:',
  '  HUQAN_GITHUB_APP_STORE_PATH, HUQAN_GITHUB_APP_ID, HUQAN_GITHUB_APP_PRIVATE_KEY_PATH',
  '',
  '  --delivery <id>     the delivery whose writeback is ambiguous',
  '  --confirm-rewrite   write the check run once when GitHub holds none with this external id',
].join('\n');

function snapshotCheckRuns(payload) {
  if (!isPlainObject(payload)
      || !Array.isArray(payload.check_runs)
      || payload.check_runs.length > MAX_CHECK_RUNS) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'the check-run list is not readable');
  }
  return payload.check_runs;
}

/**
 * The one check run that carries this external id, or nothing.
 *
 * The external id is a hash of the delivery and the receipt, so it names one
 * write. Two runs carrying it would mean the write happened twice, which is
 * not a state this tool may guess its way through.
 */
function findCheckRunByExternalId(checkRuns, externalId) {
  const matches = checkRuns.filter((run) => isPlainObject(run) && run.external_id === externalId);
  if (matches.length > 1) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'GitHub holds more than one check run with this external id');
  }
  const match = matches[0];
  if (!match) return null;
  if (!positiveSafeInteger(match.id)) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'the matching check run has no usable id');
  }
  return Object.freeze({ checkRunId: match.id });
}

function buildOutcome({ outcome, deliveryId, externalId, checkRunId, wroteCheck }) {
  const lines = [
    `delivery: ${deliveryId}`,
    `outcome: ${outcome}`,
  ];
  if (externalId) lines.push(`external id: ${externalId}`);
  if (checkRunId) lines.push(`check run: ${checkRunId}`);
  lines.push(`wrote a check run: ${wroteCheck ? 'yes' : 'no'}`);
  if (outcome === OUTCOMES.CHECK_ABSENT) {
    lines.push('GitHub holds no check run with this external id, so the write never landed.');
    lines.push('Nothing was written. Re-run with --confirm-rewrite to write it once.');
  }
  return Object.freeze({
    outcome,
    deliveryId,
    externalId: externalId || null,
    checkRunId: checkRunId || null,
    wroteCheck,
    report: lines.join('\n'),
  });
}

/**
 * Reconcile one delivery's ambiguous writeback.
 *
 * The store, the token scope and the check body all come from the C8 modules,
 * so this tool cannot drift from what the delivery itself wrote.
 */
async function reconcileWriteback({
  deliveryId,
  store,
  appId,
  privateKey,
  confirmRewrite = false,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  if (!store
      || typeof store.readWriteback !== 'function'
      || typeof store.readEvaluation !== 'function'
      || typeof store.commitWriteback !== 'function') {
    fail(ERROR_CODES.INVALID_INPUT, 'the Streaming Trust store is unavailable');
  }

  const writeback = store.readWriteback(deliveryId);
  if (writeback.state === 'complete') {
    return buildOutcome({
      outcome: OUTCOMES.ALREADY_COMPLETE,
      deliveryId,
      checkRunId: writeback.checkRunId,
      wroteCheck: false,
    });
  }
  if (writeback.state !== 'started') {
    fail(ERROR_CODES.INVALID_INPUT, 'this delivery has no ambiguous writeback to reconcile');
  }

  const evaluation = store.readEvaluation(deliveryId);
  if (!evaluation) {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'the ambiguous writeback has no evaluation to reconcile against');
  }
  const binding = writeback.binding;
  const receipt = evaluation.receipt;
  // The external id is derived, so a stored one that does not reproduce is a
  // record about something else and must not be closed by this tool.
  const externalId = checkExternalId(binding, receipt);
  if (externalId !== writeback.externalId || receipt.receiptHash !== writeback.receiptHash) {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'the stored writeback does not match its evaluation');
  }

  const access = await createStreamingTrustAccessToken({
    appId,
    privateKey,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    fetchImpl,
    nowMs,
  });

  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const listUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${binding.headSha}`
    + `/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`;
  const payload = await fetchJson(
    fetchImpl,
    listUrl,
    { method: 'GET', headers: apiHeaders(access.token) },
    ERROR_CODES.WRITEBACK_FAILED,
    AbortSignal.timeout(READ_TIMEOUT_MS),
  );

  const found = findCheckRunByExternalId(snapshotCheckRuns(payload), externalId);
  if (found) {
    const completed = store.commitWriteback({
      binding,
      receiptHash: receipt.receiptHash,
      externalId,
      checkRunId: found.checkRunId,
      completedAt: canonicalInstantFromMs(nowMs),
    });
    return buildOutcome({
      outcome: OUTCOMES.RECONCILED,
      deliveryId,
      externalId,
      checkRunId: completed.checkRunId,
      wroteCheck: false,
    });
  }

  if (!confirmRewrite) {
    return buildOutcome({
      outcome: OUTCOMES.CHECK_ABSENT,
      deliveryId,
      externalId,
      wroteCheck: false,
    });
  }

  const written = await writeCheckRun({ binding, receipt, externalId, token: access.token, fetchImpl });
  const completed = store.commitWriteback({
    binding,
    receiptHash: receipt.receiptHash,
    externalId,
    checkRunId: written.checkRunId,
    completedAt: canonicalInstantFromMs(nowMs),
  });
  return buildOutcome({
    outcome: OUTCOMES.REWRITTEN,
    deliveryId,
    externalId,
    checkRunId: completed.checkRunId,
    wroteCheck: true,
  });
}

function parseArgs(argv) {
  const options = { deliveryId: null, confirmRewrite: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--confirm-rewrite') {
      options.confirmRewrite = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--delivery') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0) {
        fail(ERROR_CODES.INVALID_INPUT, '--delivery needs a delivery id');
      }
      options.deliveryId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--delivery=')) {
      const value = arg.slice('--delivery='.length);
      if (value.length === 0) {
        fail(ERROR_CODES.INVALID_INPUT, '--delivery needs a delivery id');
      }
      options.deliveryId = value;
      continue;
    }
    fail(ERROR_CODES.INVALID_INPUT, `unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const write = typeof deps.write === 'function'
    ? deps.write
    : (text) => process.stdout.write(`${text}\n`);

  const options = parseArgs(argv);
  if (options.help) {
    write(USAGE);
    return 0;
  }
  if (!options.deliveryId) {
    write(USAGE);
    return 2;
  }

  const environment = deps.environment || process.env;
  const storePath = readCompatibleEnvironmentVariable(GITHUB_APP_STORE_PATH_ENV, environment);
  const config = readStreamingTrustConfig(environment, storePath);
  if (!config) {
    write('This deployment does not have Streaming Trust enabled, so it has no writeback to reconcile.');
    return 2;
  }

  const outcome = await reconcileWriteback({
    deliveryId: options.deliveryId,
    store: config.store,
    appId: config.appId,
    privateKey: config.privateKey,
    confirmRewrite: options.confirmRewrite,
    fetchImpl: deps.fetchImpl,
    nowMs: deps.nowMs,
  });
  write(outcome.report);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`github-app-reconcile-writeback: ${error.message} (${error.code || 'ERROR'})\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  OUTCOMES,
  main,
  reconcileWriteback,
};
