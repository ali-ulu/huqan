'use strict';

/**
 * #3493 (R38): Memory consolidation + offload.
 *
 * The archive/restore primitive pair is the reversible offload the issue asked
 * for: a record leaves the default read set but is never destroyed, and every
 * accepted offload is bound to a chained receipt. These tests use the real
 * Kernel + MemoryStore (JSON and SQLite) + receipt chain -- no stubs -- so a
 * change to any of the four surfaces (store, reads, lifecycle, CLI) shows here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = require('../cli');
const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');
const { MemoryLifecycle } = require('../lib/memory-lifecycle');
const { selectConsolidationCandidates } = require('../lib/memory-consolidation');
const { makeProvenance } = require('../lib/memory-store-utils');
const { parseCommand } = require('../lib/command-parser');

function makeKernel(useSQLite, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-${label}-${process.pid}-`));
  const opts = useSQLite
    ? { noLoad: true, useSQLite: true, dbPath: path.join(root, 'memory.db'), memoryPath: null }
    : { noLoad: true, useSQLite: false, memoryPath: path.join(root, 'memory.json'), dbPath: null };
  const kernel = new Kernel(opts);
  return { kernel, store: kernel.memory, root };
}

function seed(store, content, workspaceId = 'default') {
  const result = store.store({
    content,
    workspaceId,
    provenance: makeProvenance('tester', workspaceId, '1.0.0'),
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.memory.memoryId;
}

// Windows keeps a SQLite handle for a moment after close, so a plain rmSync
// races it and fails EPERM. Retry, then swallow: cleanup must never turn an
// already-passed assertion into a failure.
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort temp cleanup */
  }
}

const BACKENDS = [['JSON', false], ['SQLite', true]];

for (const [name, useSQLite] of BACKENDS) {
  test(`[${name}] archive hides the record from default reads and restore brings it back`, () => {
    const { kernel, store, root } = makeKernel(useSQLite, `arch-${name}`);
    const id = seed(store, { fact: 'water is wet' });

    assert.equal(store.list({ workspaceId: 'default' }).total, 1);
    const archived = store.archive(id, { workspaceId: 'default', actor: 'op' });
    assert.equal(archived.ok, true);
    assert.equal(archived.memory.status, 'archived');
    assert.equal(archived.event.eventType, 'ARCHIVE');

    // Default reads exclude it; only an explicit ask reveals it.
    assert.equal(store.list({ workspaceId: 'default' }).total, 0);
    assert.equal(store.list({ workspaceId: 'default', includeArchived: true }).total, 1);
    assert.equal(store.list({ workspaceId: 'default', includeTombstoned: true }).total, 1);
    assert.equal(store.query({ workspaceId: 'default' }).total, 0);
    assert.equal(store.exportPackage({ workspaceId: 'default' }).package.memories.length, 0);
    assert.equal(store.exportPackage({ workspaceId: 'default', includeArchived: true }).package.memories.length, 1);
    // findById is tombstone-aware: archived is hidden by default, revealed on ask.
    assert.equal(store.findById(id, { workspaceId: 'default' }).ok, false);
    assert.equal(store.findById(id, { workspaceId: 'default', includeArchived: true }).ok, true);
    assert.equal(store.findById(id, { workspaceId: 'default', includeArchived: true }).memory.status, 'archived');

    const restored = store.restore(id, { workspaceId: 'default', actor: 'op' });
    assert.equal(restored.ok, true);
    assert.equal(restored.memory.status, 'active');
    assert.equal(restored.event.eventType, 'RESTORE');
    assert.equal(store.list({ workspaceId: 'default' }).total, 1);

    kernel.close?.();
    cleanup(root);
  });

  test(`[${name}] archive is fail-closed: only active/superseded in, only archived out`, () => {
    const { kernel, store, root } = makeKernel(useSQLite, `guard-${name}`);
    const id = seed(store, { fact: 'a' });

    // Archiving twice is refused and mutates nothing.
    store.archive(id, { workspaceId: 'default' });
    const again = store.archive(id, { workspaceId: 'default' });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'INVALID_STATUS_TRANSITION');

    // Restoring a non-archived record is refused.
    store.restore(id, { workspaceId: 'default' });
    const restoreAgain = store.restore(id, { workspaceId: 'default' });
    assert.equal(restoreAgain.ok, false);
    assert.equal(restoreAgain.error.code, 'INVALID_STATUS_TRANSITION');

    // A tombstoned record cannot be archived: no audited archive may describe a
    // mutation that did not happen.
    const tombId = seed(store, { fact: 'b' });
    store.tombstone(tombId, { workspaceId: 'default' });
    const blocked = store.archive(tombId, { workspaceId: 'default' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'INVALID_STATUS_TRANSITION');

    // Unknown id is a NOT_FOUND, not a crash.
    assert.equal(store.archive('nope', { workspaceId: 'default' }).error.code, 'NOT_FOUND');

    kernel.close?.();
    cleanup(root);
  });

  test(`[${name}] archived status survives a reload`, () => {
    const { kernel, store, root } = makeKernel(useSQLite, `reload-${name}`);
    const id = seed(store, { fact: 'persist' });
    store.archive(id, { workspaceId: 'default' });
    const dbPath = store.dbPath;
    const jsonPath = store._jsonPath;
    kernel.close?.();

    const reopened = new MemoryStore(useSQLite ? { useSQLite: true, dbPath } : { useSQLite: false, memoryPath: jsonPath });
    assert.equal(reopened.list({ workspaceId: 'default' }).total, 0, 'archived stays hidden after reload');
    assert.equal(reopened.list({ workspaceId: 'default', includeArchived: true }).total, 1);
    reopened.close?.();

    cleanup(root);
  });

  test(`[${name}] restore returns a superseded record to superseded, not active`, () => {
    const { kernel, store, root } = makeKernel(useSQLite, `inverse-${name}`);
    const old = seed(store, { fact: 'v1' });
    store.supersede(old, { fact: 'v2' }, { workspaceId: 'default', actor: 'op' });

    // The ARCHIVE event records the status the record held before offload.
    const archived = store.archive(old, { workspaceId: 'default', actor: 'op' });
    assert.equal(archived.ok, true);
    assert.equal(archived.event.details.priorStatus, 'superseded');

    // Restoring to 'active' would resurrect the stale version beside its live
    // successor; the inverse of archive must return it to 'superseded'.
    const restored = store.restore(old, { workspaceId: 'default', actor: 'op' });
    assert.equal(restored.ok, true);
    assert.equal(restored.memory.status, 'superseded');
    assert.equal(restored.event.details.restoredStatus, 'superseded');
    // A superseded record stays hidden from the active-only default read set.
    assert.equal(store.list({ workspaceId: 'default' }).total, 1, 'only the live successor remains');

    // An active record still round-trips back to active.
    const live = seed(store, { fact: 'fresh' });
    store.archive(live, { workspaceId: 'default' });
    assert.equal(store.restore(live, { workspaceId: 'default' }).memory.status, 'active');

    kernel.close?.();
    cleanup(root);
  });

  test(`[${name}] restore clears archivedAt so a later write cannot stamp an active record`, () => {
    const { kernel, store, root } = makeKernel(useSQLite, `stamp-${name}`);
    const id = seed(store, { fact: 'stamp' });
    const archived = store.archive(id, { workspaceId: 'default' });
    assert.ok(archived.memory.archivedAt, 'archive stamps archivedAt');

    const restored = store.restore(id, { workspaceId: 'default' });
    assert.equal(restored.memory.status, 'active');
    assert.equal(restored.memory.archivedAt, undefined, 'restore clears the in-memory archive stamp');

    // A subsequent mutation must not resurrect the stale stamp in the row.
    store.patchMetadata(id, { note: 'touched' }, { workspaceId: 'default' });
    const reread = store.findById(id, { workspaceId: 'default' });
    assert.equal(reread.ok, true);
    assert.equal(reread.memory.status, 'active');
    assert.equal(reread.memory.archivedAt, undefined);

    kernel.close?.();
    cleanup(root);
  });
}

test('the archived event ordering is pinned so event reads stay deterministic', () => {
  const { kernel, store, root } = makeKernel(false, 'event-order');
  const id = seed(store, { fact: 'x' });
  store.archive(id, { workspaceId: 'default' });
  store.restore(id, { workspaceId: 'default' });
  const events = store.getEvents(id, { workspaceId: 'default' });
  const types = events.map((event) => event.eventType);
  assert.deepEqual(types, ['CREATED', 'ARCHIVE', 'RESTORE']);
  kernel.close?.();
  cleanup(root);
});

test('MemoryLifecycle.archive binds the offload to a chained receipt; consolidate is dry-run by default', () => {
  const { kernel, store, root } = makeKernel(false, 'lifecycle');
  const chain = require('../lib/receipt/receipt-chain');
  const lifecycle = new MemoryLifecycle(kernel, {
    memoryStore: store,
    chain: {
      GENESIS_PREVIOUS_HASH: chain.GENESIS_PREVIOUS_HASH,
      appendReceiptToChain: chain.appendReceiptToChain,
      validateReceiptChain: chain.validateReceiptChain,
    },
  });

  const old = seed(store, { fact: 'v1' });
  lifecycle.supersede(old, { fact: 'v2' }, { workspaceId: 'default', actor: 'op', reason: 'corrected' });

  // Dry-run selects the superseded record but mutates nothing.
  const dry = lifecycle.consolidate({ workspaceId: 'default', actor: 'op' });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 1);
  // The dry run names the record it would offload, so an operator can see the
  // selection before committing to --apply.
  assert.equal(dry.candidates.length, 1);
  assert.equal(dry.candidates[0].memoryId, old);
  assert.equal(dry.candidates[0].status, 'superseded');
  assert.equal(store.findById(old, { workspaceId: 'default', includeTombstoned: true }).memory.status, 'superseded');

  // Apply offloads it with a receipt.
  const applied = lifecycle.consolidate({ workspaceId: 'default', actor: 'op', reason: 'housekeeping', dryRun: false });
  assert.equal(applied.ok, true);
  assert.equal(applied.archived.length, 1);
  assert.match(applied.archived[0].receiptId, /^mlr_archive_/);
  assert.equal(store.list({ workspaceId: 'default' }).total, 1, 'only the live successor remains');

  // A refused store result yields no receipt: fail-closed.
  const refuse = lifecycle.archive('nope', { workspaceId: 'default' });
  assert.equal(refuse.ok, false);
  assert.equal(refuse.receipt, undefined);

  kernel.close?.();
  cleanup(root);
});

test('the consolidation selector is bounded and deterministic', () => {
  const { kernel, store, root } = makeKernel(false, 'selector');
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const id = seed(store, { fact: `v${i}` });
    store.supersede(id, { fact: `v${i}-next` }, { workspaceId: 'default' });
    ids.push(id);
  }
  const listed = (o) => store.list(o);
  const all = selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: 100 });
  assert.equal(all.total, 5);

  const capped = selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: 2 });
  assert.equal(capped.candidates.length, 2);

  // The cap is hard-bounded even if a caller asks for more.
  const huge = selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: 100000 });
  assert.equal(huge.candidates.length, 5);

  // Stable ordering: two calls return the same slice.
  const first = selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: 3 }).candidates.map((c) => c.memoryId);
  const second = selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: 3 }).candidates.map((c) => c.memoryId);
  assert.deepEqual(first, second);

  // A negative limit is refused, not silently clamped.
  assert.equal(selectConsolidationCandidates({ list: listed }, { workspaceId: 'default', limit: -1 }).ok, false);

  kernel.close?.();
  cleanup(root);
});

test('the CLI archive/restore/consolidate actions drive the lifecycle end-to-end', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-')), 'memory.json') });
  const cli = new CLI({ kernelInstance: kernel });
  const store = kernel.memory;
  const run = (input) => {
    const parsed = parseCommand(input);
    assert.equal(parsed.command, 'memory-lifecycle', input);
    return cli.execute('memory-lifecycle', parsed.args);
  };

  const id = seed(store, { fact: 'v1' });
  run(`memory-lifecycle supersede ${id} --content {"fact":"v2"} --reason corrected`);

  // Dry-run names candidates and mutates nothing.
  const dry = run('memory-lifecycle consolidate --workspace default');
  assert.match(dry, /consolidate dry-run: 1 candidate\(s\)/);
  assert.equal(store.list({ workspaceId: 'default' }).total, 1);

  // Apply without a reason is refused; with one it offloads and receipts.
  assert.match(run('memory-lifecycle consolidate --workspace default --apply'), /--reason <text> is required/);
  const applied = run('memory-lifecycle consolidate --workspace default --reason housekeeping --apply');
  assert.match(applied, /consolidate applied: 1 archived, 0 refused/);

  const archived = store.list({ workspaceId: 'default', includeArchived: true }).memories.find((m) => m.status === 'archived');
  assert.ok(archived, 'the superseded record is archived');
  const restored = run(`memory-lifecycle restore ${archived.memoryId} --reason undo`);
  // The record was superseded when archived, so restore returns it to
  // 'superseded' -- restoring a stale version to 'active' would resurrect it
  // beside its live successor and the consolidation would not be reversible.
  assert.match(restored, /restored \(status superseded\)\. receipt mlr_restore_/);
  assert.equal(store.list({ workspaceId: 'default', includeTombstoned: true }).memories.filter((m) => m.status === 'archived').length, 0);

  kernel.close?.();
});
