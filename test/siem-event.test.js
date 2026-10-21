'use strict';

// #4093 PR-B1: the canonical SIEM event mapper, before the formatters that
// will ride on top of it. These assert the boundary the scope note fixes: the
// event carries the receipt's identity and decision, an allowlisted field set
// and nothing else. Raw arguments, the full target path and the host's own
// statement about itself never leave the receipt.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIEM_EVENT_SCHEMA_VERSION,
  SIEM_ERRORS,
  SIEM_EVENT_FIELDS,
  receiptToSiemEvent,
} = require('../lib/siem/siem-event');

function admissionReceipt(overrides = {}) {
  return {
    receiptId: 'xact_adm_0123456789abcdef0123456789abcdef',
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: 'inv-1',
    workspaceId: 'ws-alpha',
    actor: 'codex',
    agentId: 'agent-7',
    provenanceId: 'external:codex:session-1',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    approvalId: 'not_applicable',
    approvalStatus: 'not_required',
    reason: 'no_sensitive_payload',
    riskScore: 12,
    createdAt: '2026-10-21T15:00:00.000Z',
    receiptHash: 'a'.repeat(64),
    metadata: {
      envelopeSchemaVersion: 'huqan-external-action-envelope-v1',
      agentName: 'codex',
      agentVersion: '1.2.3',
      sessionId: 'session-1',
      turnId: 'turn-9',
      toolName: 'fetch_page',
      toolKind: 'browser',
      identity: { agentId: 'agent-7', capabilities: [], delegationChain: [] },
      autonomy: null,
      inputDigest: 'b'.repeat(64),
      allowlistedCommand: '',
      fileBefore: null,
      fileTarget: '/home/operator/private/report.csv',
      destination: { scheme: 'https', host: 'example.com', path: '/a', url: 'https://example.com/a', truncated: false },
      host: { attested: false, agentId: 'codex', agentType: 'codex', model: 'gpt-5', permissionMode: 'auto' },
      findings: [
        {
          gate: 'AB9',
          decision: 'allow',
          reason: 'no_sensitive_payload',
          piiTypes: [],
          secretDetected: false,
          destinations: ['example.com'],
        },
      ],
      justification: { riskScore: 12, thresholds: { review: 40, block: 80 } },
      ruleIdentity: { policyVersion: 'huqan-external-action-guard-v1', ruleId: 'no_sensitive_payload', instanceId: 'xact_adm_0123456789abcdef0123456789abcdef' },
    },
    ...overrides,
  };
}

test('maps an admission receipt to the allowlisted SIEM event shape', () => {
  const event = receiptToSiemEvent(admissionReceipt());

  assert.deepEqual(Object.keys(event).sort(), [...SIEM_EVENT_FIELDS].sort());
  assert.equal(event['@timestamp'], '2026-10-21T15:00:00.000Z');
  assert.equal(event['event.id'], 'xact_adm_0123456789abcdef0123456789abcdef');
  assert.equal(event['event.action'], 'admit');
  assert.equal(event['huqan.schema_version'], SIEM_EVENT_SCHEMA_VERSION);
  assert.equal(event['huqan.decision'], 'allow');
  assert.equal(event['huqan.receipt.kind'], 'external_action_admission_receipt');
  assert.equal(event['huqan.risk_score'], 12);
  assert.equal(event['huqan.agent.id'], 'agent-7');
  assert.equal(event['huqan.agent.name'], 'codex');
  assert.equal(event['huqan.workspace_id'], 'ws-alpha');
  assert.equal(event['huqan.tool.name'], 'fetch_page');
  assert.equal(event['huqan.tool.kind'], 'browser');
  assert.equal(event['huqan.rule.id'], 'no_sensitive_payload');
  assert.equal(event['huqan.policy_version'], 'huqan-external-action-guard-v1');
  assert.equal(event['huqan.input_digest'], 'b'.repeat(64));
  assert.equal(event['huqan.destination.host'], 'example.com');
  assert.equal(event['huqan.redacted'], false);
  assert.deepEqual(event['huqan.findings'], [
    { gate: 'AB9', decision: 'allow', reason: 'no_sensitive_payload', pii_types: [] },
  ]);
});

test('maps review and rejection admission receipts to their actions', () => {
  assert.equal(receiptToSiemEvent(admissionReceipt({
    receiptKind: 'external_action_review_receipt', decision: 'review', status: 'review',
  }))['event.action'], 'review');
  assert.equal(receiptToSiemEvent(admissionReceipt({
    receiptKind: 'external_action_rejection_receipt', decision: 'reject', status: 'blocked',
  }))['event.action'], 'block');
});

test('never emits raw arguments, the full file path, or the host self-report', () => {
  const receipt = admissionReceipt();
  receipt.metadata.args = { body: 'SECRET ARGUMENT' };
  const event = receiptToSiemEvent(receipt);
  const serialized = JSON.stringify(event);

  assert.equal(serialized.includes('SECRET ARGUMENT'), false);
  assert.equal(serialized.includes('/home/operator/private/report.csv'), false);
  assert.equal(serialized.includes('fileTarget'), false);
  assert.equal(serialized.includes('gpt-5'), false);
  assert.equal(serialized.includes('permissionMode'), false);
});

test('carries the receipt id and hash so a reader can pivot back to evidence', () => {
  const receipt = admissionReceipt();
  const event = receiptToSiemEvent(receipt);
  assert.equal(event['event.id'], receipt.receiptId);
  assert.equal(event['huqan.receipt.hash'], receipt.receiptHash);
});

test('redacts PII and secrets via the egress gate and sets the redacted flag', () => {
  const receipt = admissionReceipt({
    reason: 'user okan@example.com triggered action with token AKIAIOSFODNN7EXAMPLE',
  });
  const event = receiptToSiemEvent(receipt);

  assert.equal(event['huqan.redacted'], true);
  assert.equal(event['huqan.reason'].includes('okan@example.com'), false);
  assert.equal(event['huqan.reason'].includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.match(event['huqan.reason'], /REDACTED/);
});

test('refuses a receipt kind it does not understand instead of guessing', () => {
  assert.throws(
    () => receiptToSiemEvent(admissionReceipt({ receiptKind: 'external_action_outcome_receipt' })),
    (error) => error.code === SIEM_ERRORS.UNSUPPORTED_RECEIPT_KIND,
  );
  assert.throws(
    () => receiptToSiemEvent({}),
    (error) => error.code === SIEM_ERRORS.INVALID_RECEIPT,
  );
});

test('the event is frozen and deterministic for identical input', () => {
  const receipt = admissionReceipt();
  const first = receiptToSiemEvent(receipt);
  const second = receiptToSiemEvent(admissionReceipt());
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(first, second);
});

test('omits the destination host when the receipt names none', () => {
  const receipt = admissionReceipt();
  receipt.metadata.destination = null;
  const event = receiptToSiemEvent(receipt);
  assert.equal('huqan.destination.host' in event, false);
});
