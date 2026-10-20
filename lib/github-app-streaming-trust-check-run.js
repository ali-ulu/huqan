'use strict';

// #2167: writing the check run, and the declined check when evaluation fails
// -- fixed reasons only, nothing from the webhook payload.

const { isPlainObject } = require('./is-plain-object');
const { positiveSafeInteger } = require('./github-app-streaming-trust-binding');
const { CHECK_NAME, ERROR_CODES, GITHUB_API_BASE, fail } = require('./github-app-streaming-trust-contract');
const { apiHeaders, budgetSignal, fetchJson, repositoryParts } = require('./github-app-streaming-trust-github-api');
const { checkConclusion, sha256Hex } = require('./github-app-streaming-trust-receipt');

/**
 * What a refusal looks like on the pull request.
 *
 * Every bound below is fail-closed, and that part is right: an oversized diff,
 * a head that moved, an unreadable file list -- none of those may be turned
 * into a verdict. But refusing by throwing and writing nothing means the pull
 * request shows no HUQAN check at all, and a check that is absent reads as a
 * check with nothing to say. That is the same shape as #681: the gate exists,
 * it did not run on this change, and the page looks fine.
 *
 * So a refusal is written down as `action_required` -- no verdict, no receipt,
 * and explicitly not a pass. The reason strings are fixed and keyed by error
 * code; the error's own message never reaches GitHub, so nothing from the
 * webhook payload can travel out through this path.
 */
const DECLINED_CONCLUSION = 'action_required';
const DECLINED_FALLBACK_CODE = 'GITHUB_APP_STREAMING_EVALUATION_FAILED';
const DECLINED_REASONS = Object.freeze({
  [ERROR_CODES.HEAD_DRIFT]: 'the pull request head moved after this delivery was signed',
  [ERROR_CODES.EVIDENCE_TOO_LARGE]: 'the changed-file evidence is larger than this loop is allowed to read',
  [ERROR_CODES.PR_READ_FAILED]: 'the pull request could not be read at the delivery head',
  [ERROR_CODES.PR_RESPONSE_INVALID]: 'the pull request response was not bound to this delivery',
  [ERROR_CODES.FILES_READ_FAILED]: 'the changed-file list could not be read at the delivery head',
  [ERROR_CODES.FILES_RESPONSE_INVALID]: 'the changed-file response was invalid',
  [ERROR_CODES.BUDGET_EXCEEDED]: 'reading the evidence took longer than this loop is allowed to spend',
  [DECLINED_FALLBACK_CODE]: 'evaluation failed before any verdict existed',
});

function declinedCheckCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return Object.hasOwn(DECLINED_REASONS, code) ? code : DECLINED_FALLBACK_CODE;
}

function declinedCheckRunBody(binding, code) {
  return Object.freeze({
    name: CHECK_NAME,
    head_sha: binding.headSha,
    status: 'completed',
    conclusion: DECLINED_CONCLUSION,
    external_id: `huqan:c8:declined:${sha256Hex(`${binding.deliveryId}:${binding.headSha}:${code}`)}`,
    output: {
      title: 'HUQAN: declined',
      summary: [
        'Declined to evaluate this delivery.',
        `Code: ${code}`,
        `Reason: ${DECLINED_REASONS[code]}`,
        'No verdict and no receipt were produced, so this is not a pass.',
      ].join('\n'),
    },
  });
}

async function reportDeclinedEvaluation({ binding, error, token, fetchImpl, signal }) {
  const code = declinedCheckCode(error);
  try {
    const [owner, repo] = repositoryParts(binding.repositoryFullName);
    await fetchImpl(`${GITHUB_API_BASE}/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(declinedCheckRunBody(binding, code)),
      signal,
    });
  } catch (_) {
    // The refusal still reaches the caller as a thrown error, so this is not a
    // silent failure -- it is a failure that could not also be shown on the
    // pull request. Replacing the original cause with a reporting failure
    // would hide the thing worth reading.
  }
  return code;
}

const ALLOW_TITLE = 'HUQAN: no blocking signal (metadata only)';

function checkRunBody(binding, receipt, externalId, publicReceipt = null, publicReceiptError = null) {
  const conclusion = checkConclusion(receipt.verdict);
  const summary = [
    `Bounded verdict: ${receipt.verdict}`,
    `Reason: ${receipt.reason}`,
    `Receipt: ${receipt.receiptHash}`,
    `Files: ${receipt.metadata.fileCount}`,
  ];
  // #4087: the check run is where a third party learns which public receipt to
  // fetch and verify. The id and checksum are the two values the import needs
  // alongside the published key; naming them here is the binding the issue
  // asks for. Absent a public receipt the summary keeps its exact prior shape.
  if (publicReceipt) {
    summary.push(`Public receipt: ${publicReceipt.publicReceiptId}`);
    summary.push(`Checksum: ${publicReceipt.integrity.checksum}`);
  } else if (publicReceiptError) {
    // Configured to publish but the signature could not be produced. Saying so
    // keeps "asked and did not" distinguishable from "never asked" -- the same
    // distinction the startup path fails closed on.
    summary.push('Public receipt: unavailable');
  }
  return Object.freeze({
    name: CHECK_NAME,
    head_sha: binding.headSha,
    status: 'completed',
    conclusion,
    external_id: externalId,
    output: {
      title: receipt.verdict === 'allow' ? ALLOW_TITLE : `HUQAN: ${receipt.verdict}`,
      summary: summary.join('\n'),
    },
  });
}

async function writeCheckRun({ binding, receipt, externalId, token, fetchImpl, requireBudget = () => 30_000, publicReceipt = null, publicReceiptError = null }) {
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const payload = await fetchJson(
    fetchImpl,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/check-runs`,
    {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(checkRunBody(binding, receipt, externalId, publicReceipt, publicReceiptError)),
    },
    ERROR_CODES.WRITEBACK_FAILED, budgetSignal(requireBudget, 'writing the check run'),
  );
  if (!isPlainObject(payload) || !positiveSafeInteger(payload.id)) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'Streaming Trust check-run response is invalid');
  }
  if (payload.head_sha !== undefined && payload.head_sha !== binding.headSha) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'Streaming Trust check-run response is bound to a different head');
  }
  return Object.freeze({ checkRunId: payload.id, conclusion: checkConclusion(receipt.verdict) });
}

module.exports = {
  DECLINED_CONCLUSION,
  DECLINED_FALLBACK_CODE,
  DECLINED_REASONS,
  checkRunBody,
  declinedCheckCode,
  declinedCheckRunBody,
  reportDeclinedEvaluation,
  writeCheckRun,
};
