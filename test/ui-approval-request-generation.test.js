'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const outcome of ['success', 'rejection']) {
  test(`old approval ${outcome} cannot overwrite a cleared session`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/js/app-approvals.js'), 'utf8');
    const start = source.indexOf('let approvalRequestGeneration=0;');
    const end = source.indexOf("$('alist').onclick", start);
    assert.ok(start >= 0 && end > start);
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const badge = {};
    const state = { authRequired: true, key: 'original-key', ws: 'default', approvals: [] };
    let health;
    const context = vm.createContext({ state, $: () => badge, json: () => pending,
      headers: () => ({ Authorization: `Bearer ${state.key}` }),
      M: (_, fallback) => fallback, readApprovals: data => data.approvals,
      surface: (_, status) => { health = status; }, renderApproval: () => {} });
    vm.runInContext(source.slice(start, end), context);
    const old = context.loadApprovals();
    state.key = '';
    await context.loadApprovals();
    assert.equal(badge.textContent, 'LOCKED');
    if (outcome === 'success') resolve({ r: { ok: true }, d: { approvals: [{ id: 'stale-private-approval' }] } });
    else reject(new Error('old network failure'));
    await old;
    assert.equal(badge.textContent, 'LOCKED');
    assert.equal(health, 'locked');
    assert.equal(state.approvals.length, 0);
  });
}

test('a newer request with the same key wins over an older response', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app-approvals.js'), 'utf8');
  const start = source.indexOf('let approvalRequestGeneration=0;');
  const end = source.indexOf("$('alist').onclick", start);
  assert.ok(start >= 0 && end > start);
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  let calls = 0;
  const badge = {};
  const state = { authRequired: true, key: 'same-key', ws: 'default', approvals: [] };
  let health;
  const response = id => ({ r: { ok: true }, d: { approvals: [{ id }] } });
  const context = vm.createContext({ state, $: () => badge,
    json: () => ++calls === 1 ? pending : Promise.resolve(response('newest')),
    headers: () => ({ Authorization: `Bearer ${state.key}` }),
    M: (_, fallback) => fallback, readApprovals: data => data.approvals,
    surface: (_, status) => { health = status; }, renderApproval: () => {} });
  vm.runInContext(source.slice(start, end), context);
  const old = context.loadApprovals();
  state.key = '';
  await context.loadApprovals();
  state.key = 'same-key';
  await context.loadApprovals();
  resolve(response('stale'));
  await old;
  assert.equal(state.approvals[0].id, 'newest');
  assert.equal(badge.textContent, 'LIVE');
  assert.equal(health, 'ok');
});
