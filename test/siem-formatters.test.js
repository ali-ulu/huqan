'use strict';

// #4093 PR-B2: the format-specific renderers that ride on the canonical SIEM
// event (PR-B1). These assert the scope note's two rules for the formatters:
// they are pure and deterministic, and they render the canonical event without
// inventing a field the allowlist does not carry (INV-B2). ECS and HEC render
// objects, CEF renders one string; `formatSiemEvent` is the single entry point
// the sink (PR-B3) will call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { receiptToSiemEvent } = require('../lib/siem/siem-event');
const {
  SIEM_FORMATS,
  SIEM_FORMATTER_ERRORS,
  ECS_DERIVED_KEYS,
  toEcs,
  toHec,
  toCef,
  formatSiemEvent,
} = require('../lib/siem/formatters');

const PRODUCT_VERSION = require('../package.json').version;

function baseMetadata() {
  return {
    agentName: 'codex',
    toolName: 'fetch_page',
    toolKind: 'browser',
    inputDigest: 'b'.repeat(64),
    destination: { scheme: 'https', host: 'example.com', path: '/a' },
    findings: [{ gate: 'AB9', decision: 'allow', reason: 'no_sensitive_payload', piiTypes: [] }],
    ruleIdentity: { ruleId: 'no_sensitive_payload' },
  };
}

function admissionReceipt(overrides = {}) {
  return {
    receiptId: 'xact_adm_0123456789abcdef0123456789abcdef',
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    workspaceId: 'ws-alpha',
    actor: 'codex',
    agentId: 'agent-7',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    reason: 'no_sensitive_payload',
    riskScore: 12,
    createdAt: '2026-10-21T15:00:00.000Z',
    receiptHash: 'a'.repeat(64),
    metadata: baseMetadata(),
    ...overrides,
  };
}

function admissionEvent(overrides) {
  return receiptToSiemEvent(admissionReceipt(overrides));
}

test('ecs output places the decision under event.outcome and the rule under rule.id', () => {
  const event = admissionEvent();
  const ecs = toEcs(event);

  assert.equal(ecs['event.outcome'], event['huqan.decision']);
  assert.equal(ecs['rule.id'], event['huqan.rule.id']);
  // The guard's own status is not an ECS outcome, so it keeps a HUQAN home
  // rather than being silently dropped by the rename.
  assert.equal(ecs['huqan.status'], event['event.outcome']);
});

test('ecs moves agent identity under user.* and keeps the huqan fields', () => {
  const event = admissionEvent();
  const ecs = toEcs(event);

  assert.equal(ecs['user.id'], event['huqan.agent.id']);
  assert.equal(ecs['user.name'], event['huqan.agent.name']);
  assert.equal(ecs['@timestamp'], event['@timestamp']);
  assert.equal(ecs['event.id'], event['event.id']);
  assert.equal(ecs['event.kind'], event['event.kind']);
  assert.equal(ecs['event.action'], event['event.action']);
  assert.equal(ecs['huqan.receipt.hash'], event['huqan.receipt.hash']);
  assert.equal(ecs['huqan.reason'], event['huqan.reason']);
  assert.equal(ecs['huqan.schema_version'], event['huqan.schema_version']);
});

test('ecs omits the destination host when the event names none', () => {
  const event = receiptToSiemEvent(admissionReceipt({ metadata: { ...baseMetadata(), destination: null } }));
  assert.equal('huqan.destination.host' in event, false);
  assert.equal('huqan.destination.host' in toEcs(event), false);
});

test('hec envelope has time, host, source, sourcetype and event', () => {
  const event = admissionEvent();
  const hec = toHec(event);

  assert.equal(hec.source, 'huqan');
  assert.equal(hec.sourcetype, 'huqan:receipt');
  assert.equal(typeof hec.host, 'string');
  assert.ok(hec.host.length > 0);
  assert.deepEqual(hec.event, event);
});

test('hec time is epoch seconds parsed from the canonical timestamp', () => {
  const event = admissionEvent();
  assert.equal(toHec(event).time, Date.parse(event['@timestamp']) / 1000);
});

test('hec host defaults to huqan and can be set by the caller', () => {
  const event = admissionEvent();
  assert.equal(toHec(event).host, 'huqan');
  assert.equal(toHec(event, { host: 'collector-1' }).host, 'collector-1');
});

test('cef header carries vendor, product, version, class id, name and severity', () => {
  const event = admissionEvent();
  const cef = toCef(event);

  assert.ok(cef.startsWith('CEF:0|HUQAN|huqan|'));
  assert.ok(cef.startsWith(
    `CEF:0|HUQAN|huqan|${PRODUCT_VERSION}|${event['huqan.receipt.kind']}|${event['huqan.decision']}|`,
  ));
  // Severity is the 0-10 CEF scale, derived from the 0-100 risk score (12 -> 1).
  // The extension escapes every `|`, so the header is exactly the first 7 parts.
  const severity = cef.split('|')[6];
  assert.equal(severity, '1');
});

test('cef escapes pipe, backslash, equals and newline per spec', () => {
  const event = admissionEvent({ reason: 'line1\nline2=a|b\\c' });
  const cef = toCef(event);
  const extension = cef.slice(cef.indexOf(' rt=') + 1);

  assert.equal(extension.includes('\n'), false);
  assert.ok(extension.includes('msg=line1\\nline2\\=a\\|b\\\\c'));
});

test('formatters are pure and deterministic for identical input', () => {
  const first = admissionEvent();
  const second = admissionEvent();

  assert.deepEqual(toEcs(first), toEcs(second));
  assert.deepEqual(toHec(first), toHec(second));
  assert.equal(toCef(first), toCef(second));
  for (const format of SIEM_FORMATS) {
    assert.equal(formatSiemEvent(first, format), formatSiemEvent(second, format));
  }
});

test('jsonl is the canonical event itself', () => {
  const event = admissionEvent();
  assert.deepEqual(JSON.parse(formatSiemEvent(event, 'jsonl')), event);
});

test('an unsupported format is refused, not guessed', () => {
  const event = admissionEvent();
  assert.throws(
    () => formatSiemEvent(event, 'ocsf'),
    (error) => error.code === SIEM_FORMATTER_ERRORS.UNSUPPORTED_FORMAT,
  );
  assert.deepEqual([...SIEM_FORMATS].sort(), ['cef', 'ecs', 'hec', 'jsonl']);
});

test('a value that is not a canonical event is refused', () => {
  assert.throws(
    () => formatSiemEvent({}, 'ecs'),
    (error) => error.code === SIEM_FORMATTER_ERRORS.INVALID_EVENT,
  );
  assert.throws(
    () => toHec(null),
    (error) => error.code === SIEM_FORMATTER_ERRORS.INVALID_EVENT,
  );
});

test('a version-matching event with a field outside the allowlist is refused', () => {
  const event = { ...admissionEvent(), 'huqan.surprise': 'leak' };
  assert.throws(
    () => formatSiemEvent(event, 'jsonl'),
    (error) => error.code === SIEM_FORMATTER_ERRORS.INVALID_EVENT
      && /unexpected canonical event field: huqan\.surprise/.test(error.message),
  );
});

test('no format emits a field outside the canonical allowlist', () => {
  const event = admissionEvent();
  const canonicalKeys = new Set(Object.keys(event));
  const derived = new Set(ECS_DERIVED_KEYS);

  for (const key of Object.keys(toEcs(event))) {
    assert.ok(canonicalKeys.has(key) || derived.has(key), `ecs invented a field: ${key}`);
  }
  // HEC carries the canonical event untouched as its payload.
  assert.deepEqual(Object.keys(toHec(event).event), Object.keys(event));
});
