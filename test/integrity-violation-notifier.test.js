'use strict';

// Siren over the emergency-stop integrity ledger (#2591).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEmergencyStop } = require('../lib/emergency-stop');
const {
  INTEGRITY_VIOLATION_TYPE,
  buildIntegrityViolationNotification,
  notifyIntegrityViolations,
} = require('../lib/integrity-violation-notifier');

function ledgerIn(t, dir) {
  const root = dir || fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-integrity-siren-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createEmergencyStop({ directory: root, now: () => '2026-09-17T10:00:00.000Z' });
}

function tamperWithStopFile(ledger) {
  const [recordFile] = fs.readdirSync(ledger.directory).filter((name) => name.endsWith('.stop.json'));
  fs.writeFileSync(path.join(ledger.directory, recordFile), 'not json', 'utf8');
}

test('a tampered stop surfaces as a listable violation entry', (t) => {
  const ledger = ledgerIn(t);
  assert.deepEqual(ledger.listIntegrityViolations(), []);
  ledger.stop({ scope: 'agent', workspaceId: 'w', agentId: 'a1', reason: 'x', actor: 'operator:ali' });
  tamperWithStopFile(ledger);
  const check = ledger.check({ workspaceId: 'w', agentId: 'a1' });
  assert.equal(check.integrityViolation, true);
  const violations = ledger.listIntegrityViolations();
  assert.equal(violations.length, 1);
  assert.equal(violations[0].seq, 1);
  assert.equal(violations[0].actor, 'system:integrity-violation');
  assert.match(violations[0].hash, /^[a-f0-9]{64}$/);
});

test('without an adapter the failure is loud, never silent', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'x', actor: 'operator:ali' });
  tamperWithStopFile(ledger);
  ledger.check({ workspaceId: 'w' });
  const result = await notifyIntegrityViolations({ emergencyStop: ledger });
  assert.equal(result.ok, false);
  assert.equal(result.notified, 0);
  assert.equal(result.failures[0].reason, 'no_notification_adapter_configured');
  assert.equal(result.violations.length, 1);
});

test('each violation notifies exactly once across runs', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'x', actor: 'operator:ali' });
  tamperWithStopFile(ledger);
  ledger.check({ workspaceId: 'w' });
  const sent = [];
  const notify = async (notification) => {
    sent.push(notification);
    return { ok: true };
  };
  const first = await notifyIntegrityViolations({ emergencyStop: ledger, notify });
  assert.equal(first.ok, true);
  assert.equal(first.notified, 1);
  assert.equal(sent[0].type, INTEGRITY_VIOLATION_TYPE);
  assert.match(sent[0].notificationId, /^integrity-violation-1-[a-f0-9]{12}$/);
  const second = await notifyIntegrityViolations({ emergencyStop: ledger, notify });
  assert.equal(second.notified, 0);
  assert.equal(sent.length, 1);
});

test('a failed delivery keeps the cursor so the next run retries', async (t) => {
  const ledger = ledgerIn(t);
  ledger.stop({ scope: 'workspace', workspaceId: 'w', reason: 'x', actor: 'operator:ali' });
  tamperWithStopFile(ledger);
  ledger.check({ workspaceId: 'w' });
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, code: 'NOTIFICATION_TIMEOUT' } : { ok: true };
  };
  const first = await notifyIntegrityViolations({ emergencyStop: ledger, notify: flaky });
  assert.equal(first.ok, false);
  assert.equal(first.failures[0].reason, 'NOTIFICATION_TIMEOUT');
  const second = await notifyIntegrityViolations({ emergencyStop: ledger, notify: flaky });
  assert.equal(second.ok, true);
  assert.equal(second.notified, 1);
});

test('the built notification carries only bounded, non-secret fields', (t) => {
  const notification = buildIntegrityViolationNotification({
    seq: 3,
    hash: 'ab'.repeat(32),
    scope: 'workspace',
    workspaceId: 'w',
    agentId: null,
    actor: 'system:integrity-violation',
    reason: 'ledger_stopped_but_file_missing',
    createdAt: '2026-09-17T10:00:00.000Z',
  }, 'w');
  assert.equal(notification.type, INTEGRITY_VIOLATION_TYPE);
  const body = JSON.stringify(notification);
  assert.doesNotMatch(body, /secret|credential|password|token/i);
  assert.ok(Buffer.byteLength(body, 'utf8') < 4096);
});
