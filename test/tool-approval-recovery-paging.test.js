'use strict';

/**
 * Regression coverage for the second half of #426.
 *
 * `recoverExpiredToolApprovals` used to materialise a single
 * `listUnresolvedToolApprovals(10_000)` result set and filter it in JS. Two
 * problems with that:
 *
 *  - The 10k cap silently truncated. Executing approvals past the cap were
 *    never recovered, and nothing reported it.
 *  - The query ordered by `updated_at`, which recovery itself rewrites, so any
 *    OFFSET-based paging over it would reorder rows mid-walk.
 *
 * It now walks `status = 'executing'` in `id` order using a keyset cursor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AxiomStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

const PAGE_SIZE = 500;

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-recovery-paging-'));
  const store = new AxiomStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Seeds `count` approvals already claimed with a lease of `leaseMs` from now. */
function seedExecuting(store, count, { leaseMs, prefix = 'exp' }) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    // Zero-padded so lexicographic `id` order is also creation order.
    const id = `${prefix}-${String(i).padStart(5, '0')}`;
    store.saveToolApprovalIfAbsent({
      id,
      approvalKey: `http.ingest.${prefix}.${i}`,
      tool: 'http.ingest',
      input: `{"n":${i}}`,
      status: 'pending',
    });
    const claim = store.claimToolApprovalWithLease(id, { owner: 'worker-a', leaseMs });
    assert.equal(claim.claimed, true, id);
    // storage clamps leaseMs to its own maximum, so assert the resulting lease
    // rather than predicting it.
    assert.ok(claim.approval.context.executionClaim.leaseExpiresAt > store._now(), id);
    ids.push(id);
  }
  return ids;
}

test('recovers every expired lease past the old 10k / single-page limit (#426)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;

    // More than two full pages, so the keyset walk must take at least three
    // round trips and terminate on the short final page.
    const total = PAGE_SIZE * 2 + 37;
    const ids = seedExecuting(store, total, { leaseMs: 1_000 });

    now = 12_000;
    const recovered = store.recoverExpiredToolApprovals({ tool: 'http.ingest', now });

    assert.equal(recovered.length, total);
    assert.deepEqual(recovered.map(a => a.id).sort(), [...ids].sort());
    for (const approval of recovered) {
      assert.equal(approval.status, 'failed');
    }
    // Nothing left executing.
    assert.equal(store.recoverExpiredToolApprovals({ tool: 'http.ingest', now }).length, 0);
  });
});

test('a page of non-expired rows still advances the cursor and terminates (#426)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;

    // A full page that never expires, ordered ahead of the expired ones by id.
    // If the walk only advanced its cursor on recovered rows it would spin on
    // this page forever; if it stopped at the first unrecovered page it would
    // never reach the expired tail.
    seedExecuting(store, PAGE_SIZE, { leaseMs: 900_000, prefix: 'aaa-live' });
    const expiredIds = seedExecuting(store, 10, { leaseMs: 1_000, prefix: 'zzz-dead' });

    now = 12_000;
    const recovered = store.recoverExpiredToolApprovals({ tool: 'http.ingest', now });

    assert.deepEqual(recovered.map(a => a.id).sort(), [...expiredIds].sort());
    // The long-lease rows are untouched.
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      assert.equal(store.getToolApprovalById(`aaa-live-${String(i).padStart(5, '0')}`).status, 'executing');
    }
  });
});

test('recovery ignores approvals belonging to a different tool (#426)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;

    seedExecuting(store, 3, { leaseMs: 1_000, prefix: 'mine' });

    store.saveToolApprovalIfAbsent({
      id: 'other-1', approvalKey: 'other.tool.1', tool: 'other.tool', input: '{}', status: 'pending',
    });
    assert.equal(store.claimToolApprovalWithLease('other-1', { owner: 'w', leaseMs: 1_000 }).claimed, true);

    now = 12_000;
    const recovered = store.recoverExpiredToolApprovals({ tool: 'http.ingest', now });

    assert.equal(recovered.length, 3);
    assert.equal(store.getToolApprovalById('other-1').status, 'executing');
  });
});
