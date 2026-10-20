'use strict';

// Streaming Trust for one GitHub App delivery: read the exact PR head and its
// changed files within a time budget, evaluate, chain a receipt onto C7 and
// write the check run. The stages live in github-app-streaming-trust-*.js (#2167).

const { createStreamingTrustAccessToken } = require('./github-app-streaming-auth');
const { canonicalInstantFromMs, snapshotC8Binding } = require('./github-app-streaming-trust-binding');
const { DECLINED_CONCLUSION, DECLINED_FALLBACK_CODE, DECLINED_REASONS, declinedCheckRunBody, reportDeclinedEvaluation, writeCheckRun } = require('./github-app-streaming-trust-check-run');
const { CHECK_NAME, DEFAULT_BUDGET_MS, ERROR_CODES, FILES_PER_PAGE, GitHubAppStreamingTrustError, MAX_FILES, MAX_FILE_PAGES, MAX_PATH_BYTES, MAX_TOTAL_CHANGES, RECEIPT_KIND, TRUST_POLICY_VERSION, fail } = require('./github-app-streaming-trust-contract');
const { budgetSignal, createBudget, readChangedFiles, readExactPullRequest } = require('./github-app-streaming-trust-github-api');
const { publishStreamingTrustPublicReceipt } = require('./github-app-streaming-trust-public-receipt');
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
  publicReceiptSigner = null,
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
  // The public receipt surface is only required when a signer is configured:
  // a deployment that never asked to publish should not be forced to grow a
  // store that can hold what it will never write.
  if (publicReceiptSigner
      && (typeof store.readPublicReceipt !== 'function' || typeof store.commitPublicReceipt !== 'function')) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust dependencies are unavailable');
  }

  // Read back the public receipt already stored for this delivery, if any. A
  // redelivery must return the stored receipt rather than sign a second one:
  // the id and checksum the first check run published have to keep resolving to
  // the exact bytes a third party already verified.
  function storedPublicReceipt() {
    if (!publicReceiptSigner) return null;
    const record = store.readPublicReceipt(binding.deliveryId);
    return record ? record.publicReceipt : null;
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
      publicReceipt: storedPublicReceipt(),
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
    // Nothing is evaluated or stored yet, so a redelivery is free to retry.
    // Without its own code this surfaced as a GitHubAppAuthError, which the
    // boundary answers as a signature failure (401).
    fail(ERROR_CODES.TOKEN_UNAVAILABLE, 'Streaming Trust could not obtain an installation token');
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

  // #4087: publish the public receipt after the evaluation is committed and
  // before the writeback, which is where the issue places it. The stored
  // receipt is preferred over a fresh signature so a redelivery that already
  // published returns the same bytes rather than a second, different receipt.
  //
  // A publication failure is not thrown: the delivery already has a verdict
  // worth writing, and losing the check run to a receipt that could not be
  // signed would trade a visible decision for none. The failure is returned as
  // a code so the caller can see that publication was attempted and did not
  // happen, which is different from never having asked.
  let publicReceipt = storedPublicReceipt();
  let publicReceiptError = null;
  if (publicReceiptSigner && !publicReceipt) {
    const published = publishStreamingTrustPublicReceipt({
      internalReceipt: receipt,
      issuedAt: canonicalInstantFromMs(nowMs),
      signer: publicReceiptSigner,
    });
    if (published.error) {
      publicReceiptError = typeof published.error.code === 'string'
        ? published.error.code
        : 'GITHUB_APP_PUBLIC_RECEIPT_PUBLISH_FAILED';
    } else if (published.publicReceipt) {
      publicReceipt = store.commitPublicReceipt(binding, receipt.receiptHash, published.publicReceipt).publicReceipt;
    }
  }

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
      publicReceipt,
      publicReceiptError,
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
    publicReceipt,
    publicReceiptError,
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
    publicReceipt,
    publicReceiptError,
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
