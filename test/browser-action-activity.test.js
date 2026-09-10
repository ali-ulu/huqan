'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  safeBrowserDestination,
  MAX_DESTINATION_BYTES,
} = require('../lib/external-action-receipt');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { projectActivityEvent } = require('../lib/workbench/activity-read');

function browserEnvelope(url, overrides = {}) {
  return normalizeExternalActionEnvelope({
    invocationId: 'inv-browser-1',
    agent: { name: 'codex', version: '1.0.0' },
    session: { id: 'sess-1', turnId: 'turn-1' },
    tool: { name: 'browser_navigate', kind: 'network' },
    args: { url },
    workspaceId: 'ws-research',
    ...overrides,
  });
}

function allowDecision() {
  return { decision: 'allow', reason: 'permitted', risk: { score: 12 }, findings: [] };
}

// The audit writer stores the receipt as `details` itself, not wrapped.
function auditEvent(receipt) {
  return {
    auditId: receipt.receiptId,
    eventType: String(receipt.receiptKind).toUpperCase(),
    targetType: 'external_agent_action',
    targetId: receipt.admissionId,
    workspaceId: receipt.workspaceId,
    actor: receipt.actor,
    timestamp: receipt.createdAt,
    sourceRef: receipt.receiptHash,
    provenanceId: receipt.provenanceId,
    trustPolicyVersion: receipt.trustPolicyVersion,
    details: receipt,
  };
}

describe('safeBrowserDestination', () => {
  it('drops the query string, fragment and embedded credentials', () => {
    const destination = safeBrowserDestination(
      'https://user:hunter2@research.example.com/docs/page?session_token=abcd1234&q=secret#frag'
    );

    assert.strictEqual(destination.url, 'https://research.example.com/docs/page');
    assert.strictEqual(destination.host, 'research.example.com');
    assert.strictEqual(destination.path, '/docs/page');
    assert.strictEqual(destination.scheme, 'https');
    const serialized = JSON.stringify(destination);
    for (const leak of ['session_token', 'abcd1234', 'hunter2', 'user:', 'secret', 'frag']) {
      assert.ok(!serialized.includes(leak), `destination leaked ${leak}: ${serialized}`);
    }
  });

  it('returns null for non-http(s) and unparseable targets', () => {
    for (const value of [
      'file:///C:/Users/sonfi/.ssh/id_rsa',
      'javascript:alert(document.cookie)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'ftp://files.example.com/dump',
      'not a url at all',
      '://missing-scheme',
      '',
      '   ',
      null,
      undefined,
      42,
      { url: 'https://example.com' },
    ]) {
      assert.strictEqual(safeBrowserDestination(value), null, `expected null for ${String(value)}`);
    }
  });

  it('caps the destination and marks it truncated', () => {
    const long = `https://example.com/${'a'.repeat(MAX_DESTINATION_BYTES * 2)}`;
    const destination = safeBrowserDestination(long);

    assert.strictEqual(destination.url.length, MAX_DESTINATION_BYTES);
    assert.strictEqual(destination.truncated, true);
    assert.ok(destination.path.length <= MAX_DESTINATION_BYTES);
  });

  it('does not mark an in-bounds destination as truncated', () => {
    const destination = safeBrowserDestination('http://localhost:8080/status');

    assert.strictEqual(destination.url, 'http://localhost:8080/status');
    assert.strictEqual(destination.host, 'localhost:8080');
    assert.strictEqual(destination.truncated, false);
  });
});

describe('external action receipts carry a bounded destination', () => {
  it('records the safe destination on the admission receipt without the secret query', () => {
    const envelope = browserEnvelope('https://api.example.com/v1/search?api_key=sk-live-should-not-appear');
    const receipt = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });

    assert.deepStrictEqual(receipt.metadata.destination, {
      scheme: 'https',
      host: 'api.example.com',
      path: '/v1/search',
      url: 'https://api.example.com/v1/search',
      truncated: false,
    });
    assert.ok(!JSON.stringify(receipt.metadata.destination).includes('sk-live-should-not-appear'));
    assert.strictEqual(receipt.metadata.toolName, 'browser_navigate');
  });

  it('leaves the destination null for a plain non-browser action and keeps existing metadata', () => {
    const envelope = normalizeExternalActionEnvelope({
      invocationId: 'inv-shell-1',
      agent: { name: 'codex', version: '1.0.0' },
      session: { id: 'sess-1', turnId: 'turn-1' },
      tool: { name: 'bash' },
      args: { command: 'git status' },
      workspaceId: 'ws-research',
    });
    const receipt = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });

    assert.strictEqual(receipt.metadata.destination, null);
    // Pre-existing metadata shape is unchanged.
    assert.strictEqual(receipt.metadata.toolName, 'bash');
    assert.strictEqual(receipt.metadata.fileBefore, null);
    assert.strictEqual(receipt.metadata.host.attested, false);
    assert.ok(typeof receipt.receiptHash === 'string' && receipt.receiptHash.length === 64);
  });

  it('carries the admission destination onto the outcome receipt', () => {
    const envelope = browserEnvelope('https://research.example.com/page?token=nope');
    const admission = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });
    const outcome = buildExternalActionOutcomeReceipt(envelope, admission, { status: 'success' }, { now: () => '2026-09-10T00:00:05.000Z' });

    assert.deepStrictEqual(outcome.metadata.destination, admission.metadata.destination);
    assert.strictEqual(outcome.metadata.toolName, 'browser_navigate');
    assert.strictEqual(outcome.metadata.outcomeStatus, 'executed');
    assert.strictEqual(outcome.metadata.effectVerification, 'reported');
  });
});

describe('activity projection of external action receipts', () => {
  it('projects the receipt stored directly in details', () => {
    const envelope = browserEnvelope('https://research.example.com/docs?secret=leaky');
    const admission = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });

    const projected = projectActivityEvent(auditEvent(admission));

    assert.notStrictEqual(projected.receipt, null);
    assert.strictEqual(projected.receipt.receiptId, admission.receiptId);
    assert.strictEqual(projected.receipt.toolName, 'browser_navigate');
    assert.strictEqual(projected.receipt.destination.url, 'https://research.example.com/docs');
    assert.ok(!JSON.stringify(projected.receipt).includes('leaky'));
  });

  it('never implies execution from an admission receipt', () => {
    const envelope = browserEnvelope('https://research.example.com/docs');
    const admission = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });

    const projected = projectActivityEvent(auditEvent(admission));

    assert.strictEqual(projected.receipt.receiptKind, 'external_action_admission_receipt');
    assert.strictEqual(projected.receipt.decision, 'allow');
    assert.strictEqual(projected.receipt.reportedOutcomeStatus, '');
    assert.strictEqual(projected.receipt.effectVerification, '');
  });

  it('projects the reported outcome and its verification level from an outcome receipt', () => {
    const envelope = browserEnvelope('https://research.example.com/docs');
    const admission = buildExternalActionAdmissionReceipt(envelope, allowDecision(), { now: () => '2026-09-10T00:00:00.000Z' });
    const outcome = buildExternalActionOutcomeReceipt(envelope, admission, { status: 'success' }, { now: () => '2026-09-10T00:00:05.000Z' });

    const projected = projectActivityEvent(auditEvent(outcome));

    assert.strictEqual(projected.receipt.receiptKind, 'external_action_outcome_receipt');
    assert.strictEqual(projected.receipt.reportedOutcomeStatus, 'executed');
    assert.strictEqual(projected.receipt.effectVerification, 'reported');
    assert.strictEqual(projected.receipt.destination.host, 'research.example.com');
  });

  it('keeps the wrapped details.receipt shape working', () => {
    const projected = projectActivityEvent({
      auditId: 'audit-1',
      eventType: 'MEMORY_ADMISSION',
      details: {
        action: 'admit',
        receipt: {
          receiptId: 'rcpt-legacy-1',
          decision: 'allow',
          reason: 'ok',
          createdAt: '2026-09-10T00:00:00.000Z',
          metadata: { tool: 'store_memory', agentId: 'agent-1', traceId: 'trace-1' },
        },
      },
    });

    assert.strictEqual(projected.receipt.receiptId, 'rcpt-legacy-1');
    assert.strictEqual(projected.receipt.tool, 'store_memory');
    assert.strictEqual(projected.receipt.toolName, undefined);
    assert.strictEqual(projected.receipt.agentId, 'agent-1');
    assert.strictEqual(projected.receipt.destination, undefined);
    assert.strictEqual(projected.receipt.reportedOutcomeStatus, undefined);
  });

  it('returns a null receipt when details carry no receipt at all', () => {
    const projected = projectActivityEvent({ auditId: 'audit-2', eventType: 'NOTE', details: { action: 'noop' } });

    assert.strictEqual(projected.receipt, null);
    assert.strictEqual(projected.action, 'noop');
  });
});
