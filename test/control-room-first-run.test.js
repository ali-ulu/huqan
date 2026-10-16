'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFirstRunTracker } = require('../public/control-room/js/control-room-overview');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key) || ''; },
  };
}

test('Control Room first run advances only on proven runtime outcomes', () => {
  const storage = memoryStorage();
  const tracker = createFirstRunTracker(storage);

  tracker.transition('click', { ok: true });
  assert.deepEqual(tracker.snapshot(), {
    connected: false,
    decisionObserved: false,
    receiptOpened: false,
    complete: false,
    completedAt: null,
  }, 'a click by itself must not complete any first-run step');

  tracker.transition('workspace_connected', { ok: false });
  assert.equal(tracker.snapshot().connected, false);

  tracker.transition('workspace_connected', { ok: true });
  assert.equal(tracker.snapshot().connected, true);
  assert.equal(tracker.snapshot().decisionObserved, false);

  tracker.transition('decision_observed', { ok: true, decision: 'unknown', receiptId: 'receipt-a' });
  assert.equal(tracker.snapshot().decisionObserved, false, 'an unrecognized decision is not proof');

  tracker.transition('decision_observed', { ok: true, decision: 'allow', receiptId: 'receipt-a' });
  assert.equal(tracker.snapshot().decisionObserved, true);
  assert.equal(tracker.expectedReceiptId(), 'receipt-a');
  assert.equal(tracker.snapshot().receiptOpened, false);

  tracker.transition('receipt_opened', { ok: true, receiptId: 'receipt-b' });
  assert.equal(tracker.snapshot().receiptOpened, false, 'opening a different receipt must not complete the step');

  tracker.transition('receipt_opened', { ok: false, receiptId: 'receipt-a' });
  assert.equal(tracker.snapshot().receiptOpened, false, 'a failed receipt read is not proof');

  tracker.transition('receipt_opened', { ok: true, receiptId: 'receipt-a' });
  const complete = tracker.snapshot();
  assert.equal(complete.receiptOpened, true);
  assert.equal(complete.complete, true);
  assert.equal(Number.isNaN(Date.parse(complete.completedAt)), false);
});

test('first-run persistence stores progress but never the observed receipt id', () => {
  const storage = memoryStorage();
  const tracker = createFirstRunTracker(storage);

  tracker.transition('decision_observed', { ok: true, decision: 'block', receiptId: 'receipt-sensitive-id' });
  const saved = storage.value('huqan-control-room-first-run-v1');

  assert.match(saved, /"decisionObserved":true/);
  assert.doesNotMatch(saved, /receipt-sensitive-id/);
});

test('Control Room wiring uses runtime events, not click completion markers', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/control-room/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/control-room/js/control-room-app.js'), 'utf8');
  const activity = fs.readFileSync(path.join(root, 'public/control-room/js/control-room-activity.js'), 'utf8');
  const overview = fs.readFileSync(path.join(root, 'public/control-room/js/control-room-overview.js'), 'utf8');

  assert.match(html, /data-first-run-step="connect"/);
  assert.match(html, /data-first-run-step="decision"/);
  assert.match(html, /data-first-run-step="receipt"/);
  assert.doesNotMatch(html, /<h3>Guided first-run setup<\/h3>/, 'shipped first run must not remain listed as planned');

  assert.match(app, /huqan:first-run-session-changed/);
  assert.match(activity, /huqan:first-run-decision-observed/);
  assert.match(activity, /Data\.fetchReceipt\(r\.receiptId\)/);
  assert.match(activity, /huqan:first-run-receipt-opened/);
  assert.match(overview, /Data\.fetchActivity\(\{ limit: 1 \}\)/);
  assert.doesNotMatch(overview, /transition\(['"]click['"]/, 'browser wiring must not complete onboarding from clicks');
});
