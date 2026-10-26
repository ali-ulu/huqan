'use strict';

// Control Room batch approvals (#4293): selection drives a bulk decision, and
// that decision must go through the queue's own submitDecision once per record,
// so a bulk action cannot dilute the audit trail into a single receipt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** A fake element: id/class lookup plus the few fields the module writes. */
function el(id) {
  return {
    id,
    hidden: true,
    disabled: true,
    checked: false,
    value: '',
    textContent: '',
    className: '',
    classList: { add() {}, remove() {}, contains: () => false },
    focus() {},
    addEventListener(type, handler) { if (type === 'click') this._click = handler; },
  };
}

function loadBatchModule(queue) {
  const ids = ['appr-toolbar', 'batch-approve', 'batch-reject', 'batch-count', 'dd-title', 'dd-summary',
    'dd-reason-field', 'dd-key-field', 'dd-reason', 'dd-key', 'dd-error', 'dd-confirm', 'decide-dialog', 'scrim'];
  const elements = Object.fromEntries(ids.map((id) => [id, el(id)]));
  const clicks = [];
  const toasts = [];
  const window = {};
  const context = vm.createContext({
    window,
    document: {
      addEventListener: (type, handler) => { if (type === 'click') clicks.push(handler); },
    },
    Set,
    Array,
    Promise,
  });
  context.window.HuqanControlRoomUI = {
    $: (sel) => elements[sel.replace(/^#/, '')] || null,
    esc: (v) => String(v),
    toast: (m) => toasts.push(m),
  };
  context.window.HuqanControlRoomApprovals = { batch: queue };
  vm.runInContext(read('public/control-room/js/control-room-approvals-batch.js'), context);
  return { Batch: window.HuqanControlRoomApprovalsBatch, elements, clicks, toasts };
}

function fakeQueue(overrides = {}) {
  return {
    tab: 'open',
    _pending: null,
    submitted: [],
    rendered: 0,
    closed: 0,
    approvals: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
    getTab() { return this.tab; },
    openList() { return this.approvals; },
    renderQueue() { this.rendered += 1; },
    setPending(v) { this._pending = v; },
    pending() { return this._pending; },
    submitDecision(id, decision, reason, key) {
      this.submitted.push({ id, decision, reason, key });
      return Promise.resolve({ ok: true });
    },
    closeDialog() { this.closed += 1; },
    ...overrides,
  };
}

function queueFor() { return fakeQueue(); }

test('a selection is per record and clears when the queue empties', () => {
  const q = queueFor();
  const { Batch, elements } = loadBatchModule(q);
  assert.match(Batch.renderSelect('a1'), /class="approval-select" data-id="a1"/);
  assert.doesNotMatch(Batch.renderSelect('a1'), /checked/);
  Batch.clear();
  q.approvals = [];
  Batch.updateToolbar();
  assert.equal(elements['appr-toolbar'].hidden, true, 'an empty open queue hides the toolbar');
});

test('the toolbar stays available while the open queue has records, so select-all is reachable first', () => {
  const q = queueFor();
  const { Batch, elements } = loadBatchModule(q);
  Batch.updateToolbar();
  assert.equal(elements['appr-toolbar'].hidden, false, 'the toolbar shows before the first row is checked');
  assert.equal(elements['batch-approve'].disabled, true, 'the actions wait for a selection');
  assert.equal(elements['batch-reject'].disabled, true);
  assert.equal(elements['batch-count'].textContent, '0 selected');
});

test('a decided record is dropped from the selection before it is counted', () => {
  const q = queueFor();
  const { Batch, elements, clicks } = loadBatchModule(q);
  const click = (target) => clicks.forEach((h) => h({ target }));
  click({ closest: () => ({ dataset: { id: 'a1' }, checked: true }), id: '' });
  click({ closest: () => ({ dataset: { id: 'a2' }, checked: true }), id: '' });
  assert.equal(elements['batch-count'].textContent, '2 selected');
  q.approvals = [{ id: 'a1' }];
  Batch.updateToolbar();
  assert.equal(elements['batch-count'].textContent, '1 selected', 'a record no longer open cannot stay selected');
});

test('checking a row enables the actions, unchecking disables them but keeps the toolbar', () => {
  const q = queueFor();
  const { Batch, elements, clicks } = loadBatchModule(q);
  const click = (target) => clicks.forEach((h) => h({ target }));
  click({ closest: () => ({ dataset: { id: 'a1' }, checked: true }), id: '' });
  assert.equal(elements['appr-toolbar'].hidden, false);
  assert.equal(elements['batch-approve'].disabled, false);
  assert.equal(elements['batch-count'].textContent, '1 selected');
  click({ closest: () => ({ dataset: { id: 'a1' }, checked: false }), id: '' });
  assert.equal(elements['batch-approve'].disabled, true, 'deselecting the last row disables the actions');
  assert.equal(elements['appr-toolbar'].hidden, false, 'the open queue keeps the toolbar visible');
});

test('select-all selects every open record and rerenders the queue', () => {
  const q = queueFor();
  const { clicks, elements } = loadBatchModule(q);
  clicks.forEach((h) => h({ target: { closest: () => null, id: 'batch-select-all', checked: true } }));
  assert.equal(q.rendered, 1);
  assert.equal(elements['batch-count'].textContent, '3 selected');
});

test('a bulk decision submits each selected record once, through the queue path', async () => {
  const q = queueFor();
  const { elements, clicks } = loadBatchModule(q);
  const click = (target) => clicks.forEach((h) => h({ target }));
  for (const id of ['a1', 'a2', 'a3']) click({ closest: () => ({ dataset: { id }, checked: true }), id: '' });
  click({ closest: () => null, id: 'batch-approve' });

  assert.equal(q.pending().purpose, 'batch');
  assert.deepEqual([...q.pending().ids], ['a1', 'a2', 'a3']);
  assert.match(elements['dd-title'].textContent, /Batch Approve 3 approvals\?/);

  elements['dd-key'].value = 'operator-key';
  const handler = elements['dd-confirm']._click;
  assert.ok(handler, 'the batch module must own the confirm click');
  await handler({ preventDefault() {} });

  assert.equal(q.submitted.length, 3, 'one submitDecision call per selected record, so one receipt each');
  assert.deepEqual(q.submitted.map((s) => s.id), ['a1', 'a2', 'a3']);
  assert.ok(q.submitted.every((s) => s.key === 'operator-key' && s.decision === 'approved'));
  assert.equal(q.closed, 1, 'the dialog closes after the batch completes');
  assert.equal(elements['appr-toolbar'].hidden, false, 'the open queue keeps the toolbar visible after the batch');
  assert.equal(elements['batch-approve'].disabled, true, 'the selection is cleared after the batch');
});

test('an empty operator key fails closed before any decision is dispatched', async () => {
  const q = queueFor();
  const { elements, clicks } = loadBatchModule(q);
  const click = (target) => clicks.forEach((h) => h({ target }));
  for (const id of ['a1', 'a2']) click({ closest: () => ({ dataset: { id }, checked: true }), id: '' });
  click({ closest: () => null, id: 'batch-approve' });

  elements['dd-key'].value = '';
  await elements['dd-confirm']._click({ preventDefault() {} });

  assert.equal(q.submitted.length, 0, 'no decision is sent without the operator key');
  assert.equal(q.closed, 0, 'the dialog stays open so the key can be entered');
  assert.match(elements['dd-error'].textContent, /Operator key is required/);
});

test('a partially failed batch keeps the failures selected and reports them', async () => {
  const q = fakeQueue({
    submitDecision(id, decision, reason, key) {
      this.submitted.push({ id, decision, reason, key });
      return Promise.resolve({ ok: id !== 'a2' });
    },
  });
  const { elements, clicks } = loadBatchModule(q);
  const click = (target) => clicks.forEach((h) => h({ target }));
  for (const id of ['a1', 'a2', 'a3']) click({ closest: () => ({ dataset: { id }, checked: true }), id: '' });
  click({ closest: () => null, id: 'batch-approve' });
  elements['dd-key'].value = 'operator-key';
  await elements['dd-confirm']._click({ preventDefault() {} });

  assert.equal(q.closed, 0, 'the dialog stays open while a retry is possible');
  assert.match(elements['dd-error'].textContent, /1 approval could not be approved/);
  assert.equal(elements['batch-count'].textContent, '1 selected', 'only the failed record stays selected');
  assert.equal(elements['batch-approve'].disabled, false, 'the retry action stays enabled');
});
