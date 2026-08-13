'use strict';

const {
  GITHUB_API_VERSION,
} = require('./github-app-beta-auth');
const { createStreamingTrustAccessToken } = require('./github-app-streaming-auth');
const { evaluateCodeChange } = require('./code-change-gate');
const { toCanonicalVerdict } = require('./verdict/action-verdict');
const {
  buildCanonicalReceiptPayload,
  sha256Hex,
  stableStringify,
} = require('./receipt/canonical-receipt');
const { appendReceiptToChain } = require('./receipt/receipt-chain');

const GITHUB_API_BASE = 'https://api.github.com';
const RECEIPT_KIND = 'github_app_streaming_trust_code_change';
const TRUST_POLICY_VERSION = 'v5-c8-streaming-trust-v1';
const CHECK_NAME = 'HUQAN Streaming Trust';
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 3;
const MAX_FILES = 200;
const MAX_PATH_BYTES = 1024;
const MAX_TOTAL_CHANGES = 1000000;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'GITHUB_APP_STREAMING_INVALID_INPUT',
  PR_READ_FAILED: 'GITHUB_APP_STREAMING_PR_READ_FAILED',
  PR_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_PR_RESPONSE_INVALID',
  HEAD_DRIFT: 'GITHUB_APP_STREAMING_HEAD_DRIFT',
  FILES_READ_FAILED: 'GITHUB_APP_STREAMING_FILES_READ_FAILED',
  FILES_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_FILES_RESPONSE_INVALID',
  EVIDENCE_TOO_LARGE: 'GITHUB_APP_STREAMING_EVIDENCE_TOO_LARGE',
  WRITEBACK_FAILED: 'GITHUB_APP_STREAMING_WRITEBACK_FAILED',
  WRITEBACK_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_WRITEBACK_RESPONSE_INVALID',
  WRITEBACK_STATE_UNKNOWN: 'GITHUB_APP_STREAMING_WRITEBACK_STATE_UNKNOWN',
});

class GitHubAppStreamingTrustError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppStreamingTrustError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppStreamingTrustError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalInstantFromMs(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust clock is invalid');
  return new Date(nowMs).toISOString();
}

function snapshotC8Binding(c7Result) {
  const binding = c7Result && c7Result.binding;
  const receipt = c7Result && c7Result.receipt;
  if (!isPlainObject(binding)
      || !isPlainObject(receipt)
      || !DELIVERY_ID_PATTERN.test(binding.deliveryId)
      || !positiveSafeInteger(binding.repositoryId)
      || typeof binding.repositoryFullName !== 'string'
      || binding.repositoryFullName.length > 256
      || !/^[^/\s]+\/[^/\s]+$/.test(binding.repositoryFullName)
      || !positiveSafeInteger(binding.installationId)
      || !positiveSafeInteger(binding.pullRequestNumber)
      || typeof binding.headSha !== 'string' || !SHA_PATTERN.test(binding.headSha)
      || typeof receipt.receiptHash !== 'string' || !HASH_PATTERN.test(receipt.receiptHash)) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust requires a valid C7 delivery result');
  }
  return Object.freeze({
    deliveryId: binding.deliveryId.toLowerCase(),
    repositoryId: binding.repositoryId,
    repositoryFullName: binding.repositoryFullName,
    installationId: binding.installationId,
    pullRequestNumber: binding.pullRequestNumber,
    headSha: binding.headSha,
    c7ReceiptHash: receipt.receiptHash,
  });
}

function repositoryParts(repositoryFullName) {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust repository identity is invalid');
  return parts.map(part => encodeURIComponent(part));
}

function apiHeaders(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust installation token is invalid');
  }
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'huqan-streaming-trust',
  };
}

async function fetchJson(fetchImpl, url, options, errorCode) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (_) {
    fail(errorCode, 'Streaming Trust GitHub request failed');
  }
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    fail(errorCode, 'Streaming Trust GitHub request was rejected');
  }
  try {
    return await response.json();
  } catch (_) {
    fail(errorCode, 'Streaming Trust GitHub response is invalid');
  }
}

async function readExactPullRequest({ binding, token, fetchImpl }) {
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const payload = await fetchJson(
    fetchImpl,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${binding.pullRequestNumber}`,
    { method: 'GET', headers: apiHeaders(token) },
    ERROR_CODES.PR_READ_FAILED,
  );
  if (!isPlainObject(payload)
      || payload.number !== binding.pullRequestNumber
      || !isPlainObject(payload.base)
      || !isPlainObject(payload.base.repo)
      || payload.base.repo.id !== binding.repositoryId
      || payload.base.repo.full_name !== binding.repositoryFullName
      || !isPlainObject(payload.head)
      || typeof payload.head.sha !== 'string'
      || !SHA_PATTERN.test(payload.head.sha)) {
    fail(ERROR_CODES.PR_RESPONSE_INVALID, 'Streaming Trust pull request response is not bound to the delivery');
  }
  if (payload.head.sha !== binding.headSha) {
    fail(ERROR_CODES.HEAD_DRIFT, 'Streaming Trust refuses to evaluate a pull request after head drift');
  }
  return Object.freeze({ headSha: payload.head.sha });
}

function snapshotChangedFile(value) {
  if (!isPlainObject(value)
      || typeof value.filename !== 'string'
      || value.filename.length === 0
      || Buffer.byteLength(value.filename, 'utf8') > MAX_PATH_BYTES
      || value.filename.includes('\0')
      || typeof value.status !== 'string'
      || !FILE_STATUSES.has(value.status)
      || !Number.isSafeInteger(value.additions) || value.additions < 0
      || !Number.isSafeInteger(value.deletions) || value.deletions < 0) {
    fail(ERROR_CODES.FILES_RESPONSE_INVALID, 'Streaming Trust changed-file response is invalid');
  }
  return Object.freeze({
    path: value.filename,
    status: value.status,
    changeType: 'source',
    additions: value.additions,
    deletions: value.deletions,
  });
}

async function readChangedFiles({ binding, token, fetchImpl }) {
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const payload = await fetchJson(
      fetchImpl,
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${binding.pullRequestNumber}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
      { method: 'GET', headers: apiHeaders(token) },
      ERROR_CODES.FILES_READ_FAILED,
    );
    if (!Array.isArray(payload) || payload.length > FILES_PER_PAGE) {
      fail(ERROR_CODES.FILES_RESPONSE_INVALID, 'Streaming Trust changed-file page is invalid');
    }
    if (files.length + payload.length > MAX_FILES) {
      fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file count exceeds its bound');
    }
    for (const item of payload) {
      const file = snapshotChangedFile(item);
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
      if (!Number.isSafeInteger(totalAdditions)
          || !Number.isSafeInteger(totalDeletions)
          || totalAdditions + totalDeletions > MAX_TOTAL_CHANGES) {
        fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file totals exceed their bound');
      }
      files.push(file);
    }
    if (payload.length < FILES_PER_PAGE) break;
    if (page === MAX_FILE_PAGES) {
      fail(ERROR_CODES.EVIDENCE_TOO_LARGE, 'Streaming Trust changed-file pagination exceeds its bound');
    }
  }

  return Object.freeze({
    files: Object.freeze(files),
    fileCount: files.length,
    totalAdditions,
    totalDeletions,
  });
}

function evaluateEvidence(binding, evidence) {
  return evaluateCodeChange({
    files: evidence.files,
    intent: 'github pull request changed files',
    operationType: 'preview',
    diffSummary: '',
    patchMetadata: {
      fileCount: evidence.fileCount,
      totalAdditions: evidence.totalAdditions,
      totalDeletions: evidence.totalDeletions,
    },
    repoState: {
      branch: `pull/${binding.pullRequestNumber}`,
      isMain: false,
      dirty: false,
      hasUntracked: false,
    },
    metadata: { workspaceId: 'default' },
  });
}

function evidenceDigest(binding, evidence) {
  return sha256Hex(stableStringify({
    repositoryId: binding.repositoryId,
    pullRequestNumber: binding.pullRequestNumber,
    headSha: binding.headSha,
    files: evidence.files,
    totalAdditions: evidence.totalAdditions,
    totalDeletions: evidence.totalDeletions,
  }));
}

function buildStreamingTrustReceipt({ binding, evidence, gate, nowMs }) {
  const verdict = toCanonicalVerdict('code_change', gate.decision);
  const evidenceSha256 = evidenceDigest(binding, evidence);
  const receiptId = `github_app_streaming_trust_${sha256Hex(`${binding.deliveryId}:${binding.headSha}:${evidenceSha256}`)}`;
  const createdAt = canonicalInstantFromMs(nowMs);
  const canonical = buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: RECEIPT_KIND,
    decision: gate.decision,
    status: 'evaluated',
    admissionId: `github_app_streaming_trust:${binding.deliveryId}`,
    workspaceId: 'default',
    actor: `github-app:${binding.installationId}`,
    agentId: `github-app:${binding.installationId}`,
    provenanceId: `github-app-delivery:${binding.deliveryId}`,
    trustPolicyVersion: TRUST_POLICY_VERSION,
    approvalStatus: verdict === 'allow' ? 'approved' : 'pending',
    reason: gate.reason,
    riskScore: gate.risk && typeof gate.risk.score === 'number' ? gate.risk.score : 0,
    createdAt,
    metadata: {
      deliveryId: binding.deliveryId,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      installationId: binding.installationId,
      pullRequestNumber: binding.pullRequestNumber,
      headSha: binding.headSha,
      c7ReceiptHash: binding.c7ReceiptHash,
      evidenceSha256,
      fileCount: evidence.fileCount,
      totalAdditions: evidence.totalAdditions,
      totalDeletions: evidence.totalDeletions,
      riskLevel: gate.risk ? gate.risk.level : 'unknown',
      riskCategories: gate.risk && Array.isArray(gate.risk.categories) ? gate.risk.categories : [],
    },
  }, { verdict });
  return appendReceiptToChain(canonical, binding.c7ReceiptHash);
}

function checkConclusion(verdict) {
  if (verdict === 'allow') return 'success';
  if (verdict === 'review' || verdict === 'dry_run_only') return 'action_required';
  if (verdict === 'block') return 'failure';
  fail(ERROR_CODES.INVALID_INPUT, 'Streaming Trust verdict cannot be projected to a check conclusion');
}

function checkExternalId(binding, receipt) {
  return `huqan:c8:${sha256Hex(`${binding.deliveryId}:${receipt.receiptHash}`)}`;
}

function checkRunBody(binding, receipt, externalId) {
  const conclusion = checkConclusion(receipt.verdict);
  const summary = [
    `Bounded verdict: ${receipt.verdict}`,
    `Reason: ${receipt.reason}`,
    `Receipt: ${receipt.receiptHash}`,
    `Files: ${receipt.metadata.fileCount}`,
  ].join('\n');
  return Object.freeze({
    name: CHECK_NAME,
    head_sha: binding.headSha,
    status: 'completed',
    conclusion,
    external_id: externalId,
    output: {
      title: `HUQAN: ${receipt.verdict}`,
      summary,
    },
  });
}

async function writeCheckRun({ binding, receipt, externalId, token, fetchImpl }) {
  const [owner, repo] = repositoryParts(binding.repositoryFullName);
  const payload = await fetchJson(
    fetchImpl,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/check-runs`,
    {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(checkRunBody(binding, receipt, externalId)),
    },
    ERROR_CODES.WRITEBACK_FAILED,
  );
  if (!isPlainObject(payload) || !positiveSafeInteger(payload.id)) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'Streaming Trust check-run response is invalid');
  }
  if (payload.head_sha !== undefined && payload.head_sha !== binding.headSha) {
    fail(ERROR_CODES.WRITEBACK_RESPONSE_INVALID, 'Streaming Trust check-run response is bound to a different head');
  }
  return Object.freeze({ checkRunId: payload.id, conclusion: checkConclusion(receipt.verdict) });
}

async function runGitHubAppStreamingTrust({
  c7Result,
  appId,
  privateKey,
  store,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
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

  const access = await createStreamingTrustAccessToken({
    appId,
    privateKey,
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    fetchImpl,
    nowMs,
  });

  if (!evaluation) {
    await readExactPullRequest({ binding, token: access.token, fetchImpl });
    const evidence = await readChangedFiles({ binding, token: access.token, fetchImpl });
    const gate = evaluateEvidence(binding, evidence);
    const receipt = buildStreamingTrustReceipt({ binding, evidence, gate, nowMs });
    evaluation = store.commitEvaluation(binding, receipt);
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
  GitHubAppStreamingTrustError,
  readExactPullRequest,
  readChangedFiles,
  buildStreamingTrustReceipt,
  checkConclusion,
  runGitHubAppStreamingTrust,
};
