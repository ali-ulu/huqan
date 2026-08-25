'use strict';

/**
 * #1541: ErrorPreventionStore.listKind() listed the entire workspace and
 * filtered the returned array afterwards. MemoryStore.list() deep-copies every
 * record it returns, so preflight -- the decision path that runs before every
 * gated action -- paid a full clone of the whole workspace to find prevention
 * rules, whether or not a single rule existed.
 *
 * The cost was linear in workspace size: 0.04 ms at 0 records, 17.8 ms at 8000,
 * with zero active rules. These tests pin the mechanism that removed it rather
 * than a wall-clock number: the kind filter is pushed into the store, so the
 * number of records that ever get cloned is the number of rules, not the size
 * of the workspace.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const MemoryStore = require('../lib/memory-store');
const ErrorPreventionStore = require('../lib/error-prevention/store');

function seedWorkspace(store, { rules = 0, unrelated = 0, workspaceId = 'default' } = {}) {
  for (let i = 0; i < rules; i += 1) {
    store.store({ content: { kind: 'error_prevention_rule', ruleId: `rule-${i}` }, workspaceId });
  }
  for (let i = 0; i < unrelated; i += 1) {
    store.store({ content: { kind: 'unrelated', n: i }, workspaceId });
  }
  return store;
}

describe('#1541 listKind filters before records are cloned', () => {
  it('the number of records returned by the store is the number of rules, not the workspace size', () => {
    const store = new MemoryStore();
    seedWorkspace(store, { rules: 3, unrelated: 500 });

    let returnedByStore = -1;
    const realList = store.list.bind(store);
    store.list = (opts) => {
      const result = realList(opts);
      returnedByStore = result.memories.length;
      return result;
    };

    const result = new ErrorPreventionStore(store).listKind('error_prevention_rule');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.total, 3);
    // The assertion that matters: 3, not 503. Everything the store hands back
    // has already been deep-copied, so anything extra here is pure waste.
    assert.strictEqual(returnedByStore, 3, 'the store must not return the whole workspace');
  });

  it('that number does not grow as unrelated records are added', () => {
    const store = new MemoryStore();
    seedWorkspace(store, { rules: 2 });

    const eps = new ErrorPreventionStore(store);
    let returnedByStore = -1;
    const realList = store.list.bind(store);
    store.list = (opts) => {
      const result = realList(opts);
      returnedByStore = result.memories.length;
      return result;
    };

    const cloned = [];
    for (const size of [0, 100, 400]) {
      seedWorkspace(store, { unrelated: size });
      eps.listKind('error_prevention_rule');
      cloned.push(returnedByStore);
    }

    assert.deepStrictEqual(cloned, [2, 2, 2], 'clone count must not track workspace size');
  });

  it('still returns exactly the records of that kind', () => {
    const store = new MemoryStore();
    seedWorkspace(store, { rules: 2, unrelated: 5 });
    store.store({ content: { kind: 'error_prevention_failure', failureId: 'f-1' }, workspaceId: 'default' });

    const eps = new ErrorPreventionStore(store);
    const rules = eps.listKind('error_prevention_rule');
    assert.strictEqual(rules.total, 2);
    assert.ok(rules.memories.every((memory) => memory.content.kind === 'error_prevention_rule'));

    assert.strictEqual(eps.listKind('error_prevention_failure').total, 1);
    assert.strictEqual(eps.listKind('kind-that-does-not-exist').total, 0);
  });

  it('stays workspace-scoped', () => {
    const store = new MemoryStore();
    seedWorkspace(store, { rules: 2, workspaceId: 'tenant-a' });
    seedWorkspace(store, { rules: 5, workspaceId: 'tenant-b' });

    const eps = new ErrorPreventionStore(store);
    assert.strictEqual(eps.listKind('error_prevention_rule', { workspaceId: 'tenant-a' }).total, 2);
    assert.strictEqual(eps.listKind('error_prevention_rule', { workspaceId: 'tenant-b' }).total, 5);
    assert.strictEqual(eps.listKind('error_prevention_rule').total, 0, 'default workspace has none');
  });

  it('list() without contentKind is unchanged for every other caller', () => {
    const store = new MemoryStore();
    seedWorkspace(store, { rules: 2, unrelated: 3 });

    assert.strictEqual(store.list({ workspaceId: 'default' }).total, 5);
    assert.strictEqual(store.list({ workspaceId: 'default', contentKind: 'unrelated' }).total, 3);
    // An empty or non-string contentKind is "no filter", not "match nothing".
    assert.strictEqual(store.list({ workspaceId: 'default', contentKind: '' }).total, 5);
    assert.strictEqual(store.list({ workspaceId: 'default', contentKind: null }).total, 5);
  });
});
