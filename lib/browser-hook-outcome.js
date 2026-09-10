'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { normalizeHookInvocation } = require('./external-action-adapter');
const { normalizeExternalActionEnvelope, redactExternalValue } = require('./external-action-envelope');
const { recordExternalActionOutcome } = require('./external-action-guard');
const { stableStringify, hashCanonicalReceiptPayload } = require('./receipt/canonical-receipt');

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
    // Hash-only through the existing receipt builder; no page content persisted.
    output: payload.tool_response ?? payload.error ?? null,
  }, options);
  if (!result.ok || !result.receiptPersisted) throw new Error('Browser outcome persistence failed');
  return { ok: true, receiptId: result.receipt.receiptId };
}

module.exports = { recordBrowserHookOutcome, isBrowserTool };
