'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { normalizeHookInvocation } = require('./external-action-adapter');
const { normalizeExternalActionEnvelope, redactExternalValue } = require('./external-action-envelope');
const { recordExternalActionOutcome } = require('./external-action-guard');
const { latestExternalActionReview, persistExternalActionReceipt } = require('./external-action-receipt');
const { buildCanonicalReceiptPayload, hashCanonicalReceiptPayload, stableStringify } = require('./receipt/canonical-receipt');
const { fromMcpDecision } = require('./verdict/action-verdict');

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const isBrowserTool = name => typeof name === 'string' && /browser|playwright|puppeteer/i.test(name);

// Read only a bounded recent window. Missing admission evidence is an error,
// never permission to fabricate a successful browser operation.
function recentReceipts(receiptPath) {
  const fd = fs.openSync(receiptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_TAIL_BYTES));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean).reverse();
  } finally { fs.closeSync(fd); }
}

// #2141 (part A of #2110): consent-based, sanitized page preview. The default
// stays hash-only: no consent flag, no page content -- ever. Consent is a
// deployment-level decision carried in options (`pagePreview`) or the
// `HUQAN_BROWSER_PAGE_PREVIEW` environment variable; the hook payload is
// attacker-influenced and can never grant it.
const PAGE_PREVIEW_RECEIPT_KIND = 'browser_page_preview_receipt';
const PREVIEW_SNIPPET_LIMIT = 2048;
const PAGE_PREVIEW_MODES = Object.freeze(['text', 'screenshot']);

function parsePagePreviewModes(raw) {
  const parts = String(raw || '').toLowerCase().split(',').map(part => part.trim()).filter(Boolean);
  const modes = parts.filter(part => PAGE_PREVIEW_MODES.includes(part));
  if (!modes.length || modes.length !== parts.length) return null;
  return { text: modes.includes('text'), screenshot: modes.includes('screenshot') };
}

function pagePreviewConsent(options = {}, environment = process.env) {
  const explicit = options.pagePreview;
  if (typeof explicit === 'string') {
    const modes = parsePagePreviewModes(explicit);
    return modes ? { ...modes, source: 'options' } : null;
  }
  if (explicit && typeof explicit === 'object') {
    const text = explicit.text === true;
    const screenshot = explicit.screenshot === true;
    return (text || screenshot) ? { text, screenshot, source: 'options' } : null;
  }
  if (explicit !== undefined && explicit !== null) return null;
  const fromEnv = parsePagePreviewModes(environment.HUQAN_BROWSER_PAGE_PREVIEW);
  return fromEnv ? { ...fromEnv, source: 'env' } : null;
}

// Line-wise redaction keeps a secret-bearing line from erasing the whole
// snippet the way a whole-string match would, while `redactExternalValue`
// still makes the call on every line.
function pagePreviewSnippet(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.trim()) return null;
  const redacted = raw.split('\n').map(line => String(redactExternalValue(line))).join('\n');
  const collapsed = redacted
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!collapsed) return null;
  const snippet = collapsed.slice(0, PREVIEW_SNIPPET_LIMIT);
  return { snippet, truncated: collapsed.length > PREVIEW_SNIPPET_LIMIT };
}

// A screenshot is consented to as a fingerprint, never as an image: the
// decoded bytes exist only long enough to be hashed and are gone.
function pagePreviewScreenshot(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length) return null;
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

function previewReceiptId(fields) {
  return `browser_prev_${crypto.createHash('sha256').update(fields.join('|'), 'utf8').digest('hex').slice(0, 32)}`;
}

// Bound to the outcome by id and by the outcome's own hash, the same way an
// outcome review (#2137) binds. The preview is deliberately a separate
// receipt, not new outcome metadata: the canonical outcome projection is
// fixed, and a consented preview must stay impossible to confuse with the
// hash-only record every deployment gets by default.
function buildBrowserPagePreviewReceipt(outcomeReceipt, admission, preview, createdAt) {
  const text = preview.text || null;
  const screenshot = preview.screenshot || null;
  const receipt = {
    receiptId: previewReceiptId([outcomeReceipt.receiptId, text ? text.snippet : '', screenshot ? screenshot.sha256 : '', createdAt]),
    receiptKind: PAGE_PREVIEW_RECEIPT_KIND,
    decision: admission.decision,
    status: 'preview',
    admissionId: outcomeReceipt.admissionId,
    workspaceId: outcomeReceipt.workspaceId,
    actor: outcomeReceipt.actor,
    agentId: outcomeReceipt.agentId || '',
    memoryDraftId: 'not_applicable',
    provenanceId: outcomeReceipt.provenanceId,
    trustPolicyVersion: outcomeReceipt.trustPolicyVersion,
    approvalId: outcomeReceipt.approvalId || 'not_applicable',
    approvalStatus: outcomeReceipt.approvalStatus || 'not_required',
    reason: 'browser_page_preview_consented',
    riskScore: outcomeReceipt.riskScore,
    createdAt,
    metadata: {
      outcomeReceiptId: outcomeReceipt.receiptId,
      outcomeReceiptHash: outcomeReceipt.receiptHash || '',
      admissionReceiptId: admission.receiptId,
      sessionId: admission.metadata?.sessionId || '',
      toolName: admission.metadata?.toolName || '',
      destination: admission.metadata?.destination || null,
      consentSource: preview.consentSource,
      text,
      screenshot,
    },
  };
  const verdict = fromMcpDecision({ decision: receipt.decision, reason: receipt.reason }).verdict;
  const canonical = buildCanonicalReceiptPayload(receipt, { verdict });
  return Object.freeze({ ...canonical, receiptHash: hashCanonicalReceiptPayload(canonical) });
}

function recordBrowserHookOutcome(profile, payload, options = {}) {
  if (!['PostToolUse', 'PostToolUseFailure'].includes(payload?.hook_event_name)) {
    throw new Error('Unsupported browser outcome hook event');
  }
  const input = normalizeHookInvocation(profile, payload, options);
  if (!isBrowserTool(input.toolName)) return { ok: true, ignored: true };
  const envelope = normalizeExternalActionEnvelope(input, options);
  if (envelope.malformed || envelope.generatedInvocationId || !envelope.session.id) {
    throw new Error('Browser outcome requires a valid invocation and session');
  }
  const receipts = recentReceipts(options.receiptWriter.path);
  const admission = receipts.find(receipt => receipt.receiptKind === 'external_action_admission_receipt'
    && receipt.admissionId === envelope.invocationId && receipt.workspaceId === envelope.workspaceId
    && receipt.actor === envelope.agent.name && receipt.metadata?.sessionId === envelope.session.id
    && receipt.metadata?.toolName === envelope.tool.name);
  if (!admission || admission.decision !== 'allow') throw new Error('Matching browser admission not found');
  const { receiptHash, ...canonical } = admission;
  const inputDigest = crypto.createHash('sha256').update(stableStringify(redactExternalValue(envelope.args))).digest('hex');
  if (receiptHash !== hashCanonicalReceiptPayload(canonical) || admission.metadata.inputDigest !== inputDigest) {
    throw new Error('Browser admission evidence mismatch');
  }
  if (receipts.some(receipt => receipt.receiptKind === 'external_action_outcome_receipt'
    && receipt.metadata?.admissionReceiptId === admission.receiptId)) return { ok: true, duplicate: true };
  const failed = payload.hook_event_name === 'PostToolUseFailure' || payload.tool_response?.isError === true;
  const result = recordExternalActionOutcome(input, admission, {
    status: failed ? 'failed' : 'success',
    reason: failed ? 'browser_tool_reported_failure' : 'browser_tool_reported_success',
    output: payload.tool_response ?? payload.error ?? null,
  }, options);
  if (!result.ok || !result.receiptPersisted) throw new Error('Browser outcome persistence failed');
  // #2139: surface the monitor verdict and whether a human decision is owed.
  // review-required is derived only from the guard monitoring summary and
  // quarantine result -- never from the attacker-influenced hook payload.
  const monitoringSummary = result.monitoring && result.monitoring.active ? result.monitoring.receiptSummary : null;
  const reviewState = {
    quarantined: result.quarantined === true,
    demotedTo: result.quarantined === true ? (result.demotedTo || null) : null,
    monitoringDecision: monitoringSummary ? monitoringSummary.decision : null,
    reviewRequired: result.quarantined === true
      || monitoringSummary?.decision === 'observe_quarantine_required'
      || monitoringSummary?.quarantine?.humanReleaseRequired === true,
  };
  // Consented preview, best effort and append-only: a preview failure must
  // never retro-invalidate the outcome that was already durably recorded.
  // A failed tool call reports an error, not a page, so it is never previewed.
  const preview = (!failed ? collectPagePreview(payload, options) : null);
  if (preview && !receipts.some(receipt => receipt.receiptKind === PAGE_PREVIEW_RECEIPT_KIND
    && receipt.metadata?.outcomeReceiptId === result.receipt.receiptId)) {
    try {
      const previewReceipt = buildBrowserPagePreviewReceipt(result.receipt, admission, preview, new Date().toISOString());
      if (!persistExternalActionReceipt(options.receiptWriter, previewReceipt)) throw new Error('preview persistence refused');
      return { ok: true, receiptId: result.receipt.receiptId, ...reviewState, previewReceiptId: previewReceipt.receiptId };
    } catch (error) {
      return { ok: true, receiptId: result.receipt.receiptId, ...reviewState, previewError: String(error?.message || error) };
    }
  }
  return { ok: true, receiptId: result.receipt.receiptId, ...reviewState };
}

// The same re-verification the admission lookup applies: an outcome that does
// not hash back to its recorded hash is corruption, not evidence.
function receiptHashVerifies(receipt) {
  const { receiptHash, ...canonicalSource } = receipt;
  if (typeof receiptHash !== 'string' || !receiptHash) return false;
  try {
    const verdict = fromMcpDecision({ decision: receipt.decision, reason: receipt.reason }).verdict;
    return hashCanonicalReceiptPayload(buildCanonicalReceiptPayload(canonicalSource, { verdict })) === receiptHash;
  } catch (_) {
    return false;
  }
}

/**
 * #2139: the browser review chain in one answer. Resolves the outcome
 * receipt (only one whose own hash still verifies), the monitor verdict on
 * it, and -- via the #2137 review receipts -- the newest human decision. The
 * duplicate short-circuit in `recordBrowserHookOutcome` stays shape-stable;
 * callers resolving an already-recorded outcome use this reader instead.
 */
function browserOutcomeReviewState(receiptPath, outcomeReceiptId) {
  const target = typeof outcomeReceiptId === 'string' ? outcomeReceiptId.trim() : '';
  if (!target) throw new TypeError('browserOutcomeReviewState requires the outcome receipt id');
  const outcome = recentReceipts(receiptPath).find(receipt =>
    receipt.receiptKind === 'external_action_outcome_receipt'
    && receipt.receiptId === target
    && receiptHashVerifies(receipt)) || null;
  const monitoring = outcome?.metadata?.monitoring || null;
  const quarantined = monitoring?.quarantine?.applied === true;
  const latestReview = outcome ? latestExternalActionReview(receiptPath, target) : null;
  return {
    outcome,
    quarantined,
    demotedTo: quarantined ? (monitoring.quarantine.demotedTo || null) : null,
    monitoringDecision: monitoring ? monitoring.decision : null,
    reviewRequired: quarantined
      || monitoring?.decision === 'observe_quarantine_required'
      || monitoring?.quarantine?.humanReleaseRequired === true,
    reviewed: latestReview !== null,
    latestReview,
  };
}

function collectPagePreview(payload, options = {}) {
  const consent = pagePreviewConsent(options);
  if (!consent) return null;
  const response = payload.tool_response || {};
  const text = consent.text ? pagePreviewSnippet(response.content ?? response.text) : null;
  const screenshot = consent.screenshot ? pagePreviewScreenshot(response.screenshot ?? response.image) : null;
  if (!text && !screenshot) return null;
  return { text, screenshot, consentSource: consent.source };
}

module.exports = {
  recordBrowserHookOutcome,
  browserOutcomeReviewState,
  isBrowserTool,
  buildBrowserPagePreviewReceipt,
  pagePreviewConsent,
  pagePreviewSnippet,
  pagePreviewScreenshot,
};
