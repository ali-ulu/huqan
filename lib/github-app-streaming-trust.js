'use strict';

// Streaming Trust for one GitHub App delivery: read the exact PR head and its
// changed files within a time budget, evaluate, chain a receipt onto C7 and
// write the check run. The stages live in github-app-streaming-trust-*.js (#2167).

const { createStreamingTrustAccessToken } = require('./github-app-streaming-auth');
const { canonicalInstantFromMs, snapshotC8Binding } = require('./github-app-streaming-trust-binding');
const { DECLINED_CONCLUSION, DECLINED_FALLBACK_CODE, DECLINED_REASONS, declinedCheckRunBody, reportDeclinedEvaluation, writeCheckRun } = require('./github-app-streaming-trust-check-run');
const { CHECK_NAME, DEFAULT_BUDGET_MS, ERROR_CODES, FILES_PER_PAGE, GitHubAppStreamingTrustError, MAX_FILES, MAX_FILE_PAGES, MAX_PATH_BYTES, MAX_TOTAL_CHANGES, RECEIPT_KIND, TRUST_POLICY_VERSION, fail } = require('./github-app-streaming-trust-contract');
const { budgetSignal, createBudget, readChangedFiles, readExactPullRequest } = require('./github-app-streaming-trust-github-api');
const { buildStreamingTrustReceipt, checkConclusion, checkExternalId, evaluateEvidence } = require('./github-app-streaming-trust-receipt');

async function runGitHubAppStreamingTrust({
  c7Result,
  appId,
  privateKey,
  store,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  budgetMs = DEFAULT_BUDGET_MS,
  elapsedMs = () => Math.trunc(performance.now()),
}) {
  const binding = snapshotC8Binding(c7Result);
  if (!store
      || typeof store.readEvaluation !== 'function'
      || typeof store.commitEvaluation !== 'function'
      || typeof store.readWriteback !== 'function'
      || typeof store.reserveWriteback !== 'function'
      || typeof store.commitWriteback !== 'function'
      || typeof fetchImpl !== 'function') {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust dependencies are unavailable');
  }

  let evaluation = store.readEvaluation(binding.deliveryId);
  let writeback = store.readWriteback(binding.deliveryId);
  if (evaluation && writeback.state === 'complete') {
    return Object.freeze({
      duplicate: true,
      binding,
      receipt: evaluation.receipt,
      checkRunId: writeback.checkRunId,
      conclusion: checkConclusion(evaluation.receipt.verdict),
    });
  }
  if (writeback.state === 'started') {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Streaming Trust writeback state is ambiguous; automatic replay is refused');
  }

  const requireBudget = createBudget({ budgetMs, elapsedMs });
  let access;
  const tokenSignal = budgetSignal(requireBudget, 'creating the installation token');
  try {
    access = await createStreamingTrustAccessToken({
      appId,
      privateKey,
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      fetchImpl,
      nowMs,
      signal: tokenSignal,
    });
  } catch (error) {
    if (tokenSignal.aborted) {
      fail(ERROR_CODES.BUDGET_EXCEEDED, 'Streaming Trust evaluation budget expired while creating its installation token');
    }
    throw error;
  }

  if (!evaluation) {
    try {
      // The budget starts at the token because that is the first outbound call
      // and the first place a slow GitHub can begin spending the delivery's
      // ten seconds. The writeback below is outside it on purpose: it is the
      // one call that makes the result visible, and abandoning it to save time
      // would trade a slow answer for no answer.
      requireBudget('reading the pull request');
      await readExactPullRequest({ binding, token: access.token, fetchImpl, requireBudget });
      const evidence = await readChangedFiles({ binding, token: access.token, fetchImpl, requireBudget });
      const gate = evaluateEvidence(binding, evidence);
      const receipt = buildStreamingTrustReceipt({ binding, evidence, gate, nowMs });
      evaluation = store.commitEvaluation(binding, receipt);
    } catch (error) {
      // Everything from the token onwards to a committed evaluation is covered,
      // including errors this module did not raise itself: a gap here is a
      // refusal nobody can see.
      //
      // The refusal is deliberately not written to the store. A read failure
      // can be transient, and a redelivery has to be free to evaluate properly
      // the second time; persisting the decline would freeze the delivery on
      // the worst moment it ever had. The writeback stage below is excluded
      // for the opposite reason -- there, writing a check is the thing that
      // just failed, and refusing a second write is the point.
      await reportDeclinedEvaluation({ binding, error, token: access.token, fetchImpl, signal: budgetSignal(requireBudget, 'reporting the declined evaluation') });
      throw error;
    }
  }

  const receipt = evaluation.receipt;
  const externalId = checkExternalId(binding, receipt);
  writeback = store.reserveWriteback({
    binding,
    receiptHash: receipt.receiptHash,
    externalId,
    startedAt: canonicalInstantFromMs(nowMs),
  });
  if (writeback.state === 'complete') {
    return Object.freeze({
      duplicate: true,
      binding,
      receipt,
      checkRunId: writeback.checkRunId,
      conclusion: checkConclusion(receipt.verdict),
    });
  }
  if (writeback.state !== 'reserved') {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Streaming Trust writeback state is ambiguous; automatic replay is refused');
  }

  const written = await writeCheckRun({
    binding,
    receipt,
    externalId,
    token: access.token,
    fetchImpl,
    requireBudget,
  });
  const completed = store.commitWriteback({
    binding,
    receiptHash: receipt.receiptHash,
    externalId,
    checkRunId: written.checkRunId,
    completedAt: canonicalInstantFromMs(nowMs),
  });

  return Object.freeze({
    duplicate: Boolean(c7Result.duplicate || evaluation.duplicate),
    binding,
    receipt,
    checkRunId: completed.checkRunId,
    conclusion: written.conclusion,
  });
}

module.exports = {
  RECEIPT_KIND,
  TRUST_POLICY_VERSION,
  CHECK_NAME,
  FILES_PER_PAGE,
  MAX_FILE_PAGES,
  MAX_FILES,
  MAX_PATH_BYTES,
  MAX_TOTAL_CHANGES,
  ERROR_CODES,
  DEFAULT_BUDGET_MS,
  DECLINED_CONCLUSION,
  DECLINED_FALLBACK_CODE,
  DECLINED_REASONS,
  GitHubAppStreamingTrustError,
  declinedCheckRunBody,
  readExactPullRequest,
  readChangedFiles,
  buildStreamingTrustReceipt,
  checkConclusion,
  runGitHubAppStreamingTrust,
};
