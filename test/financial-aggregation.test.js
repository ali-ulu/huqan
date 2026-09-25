'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  DEFAULT_WINDOW_MS,
  parseDecimalAmount,
  sumAmounts,
  recordPayment,
  readPaymentTotals,
} = require('../lib/financial-aggregation');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-finagg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const SCOPE = Object.freeze({ policyVersion: 'policy-v1', workspaceId: 'workspace-a', taskId: 'task-1' });

test('exact decimals parse without floating point and sum exactly', () => {
  assert.deepEqual(parseDecimalAmount('10.50'), { units: '1050', scale: 2 });
  assert.deepEqual(parseDecimalAmount('100'), { units: '100', scale: 0 });
  assert.deepEqual(parseDecimalAmount(7), { units: '7', scale: 0 });
  assert.deepEqual(sumAmounts([parseDecimalAmount('0.1'), parseDecimalAmount('0.2')]), { units: '3', scale: 1 });
  assert.deepEqual(sumAmounts([{ units: '1050', scale: 2 }, { units: '5', scale: 0 }]), { units: '1550', scale: 2 });
  for (const bad of ['0', '0.00', '-5', 'abc', '1.2.3', '', 1.5, NaN, null, undefined, {}, '1'.repeat(25)]) {
    assert.equal(parseDecimalAmount(bad), null, JSON.stringify(bad));
  }
});

test('payments sum by destination and task inside the window, split-proof', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPayment(graph, {
    scope: SCOPE, destination: 'vendor-x', currency: 'usd', amount: '60.00',
    idempotencyKey: 'p1', at: iso(BASE),
  });
  // Same destination and task, second payment: splitting does not avoid the sum.
  recordPayment(graph, {
    scope: SCOPE, destination: 'vendor-x', currency: 'usd', amount: '50',
    idempotencyKey: 'p2', at: iso(BASE + HOUR),
  });
  recordPayment(graph, {
    scope: { ...SCOPE, taskId: 'task-2' }, destination: 'vendor-x', currency: 'usd', amount: '5',
    idempotencyKey: 'p3', at: iso(BASE + HOUR),
  });
  const totals = readPaymentTotals(graph, { scope: { ...SCOPE, taskId: null }, at: iso(BASE + 2 * HOUR) });
  assert.deepEqual(totals.byDestination['vendor-x'].USD, { units: '11500', scale: 2 });
  assert.deepEqual(totals.byTask['task-1'].USD, { units: '11000', scale: 2 });
  assert.deepEqual(totals.byTask['task-2'].USD, { units: '5', scale: 0 });
  assert.equal(totals.windowMs, DEFAULT_WINDOW_MS);
});

test('the window excludes old rows and the same key never double-counts', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordPayment(graph, {
    scope: SCOPE, destination: 'vendor-x', currency: 'USD', amount: '10',
    idempotencyKey: 'p1', at: iso(BASE),
  });
  const replay = recordPayment(graph, {
    scope: SCOPE, destination: 'vendor-x', currency: 'USD', amount: '9999',
    idempotencyKey: 'p1', at: iso(BASE),
  });
  assert.equal(replay.replayed, true);
  const fresh = readPaymentTotals(graph, { scope: SCOPE, at: iso(BASE + HOUR) });
  assert.deepEqual(fresh.byDestination['vendor-x'].USD, { units: '10', scale: 0 });
  const aged = readPaymentTotals(graph, { scope: SCOPE, at: iso(BASE + DEFAULT_WINDOW_MS + HOUR) });
  assert.deepEqual(aged.byDestination, {});
  assert.deepEqual(aged.byTask, {});
});

test('state survives reopening and malformed calls fail closed', (t) => {
  const dir = tempDir(t);
  recordPayment(memoryGraph(dir), {
    scope: SCOPE, destination: 'vendor-x', currency: 'EUR', amount: '3.25',
    idempotencyKey: 'p1', at: iso(BASE),
  });
  const totals = readPaymentTotals(memoryGraph(dir), { scope: SCOPE, at: iso(BASE + HOUR) });
  assert.deepEqual(totals.byDestination['vendor-x'].EUR, { units: '325', scale: 2 });

  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordPayment(graph, { scope: SCOPE, destination: 'vendor-x', currency: 'US', amount: '1', idempotencyKey: 'k' }), /currency/);
  assert.throws(() => recordPayment(graph, { scope: SCOPE, destination: 'vendor-x', currency: 'USD', amount: 1.5, idempotencyKey: 'k' }), /amount/);
  assert.throws(() => recordPayment(graph, { scope: SCOPE, destination: 'a\0b', currency: 'USD', amount: '1', idempotencyKey: 'k' }), /null characters/);
  assert.throws(() => readPaymentTotals(graph, { scope: SCOPE, windowMs: -5 }), /windowMs/);
  assert.deepEqual(readPaymentTotals(graph, { scope: SCOPE, at: iso(BASE) }).byDestination, {});
});
