'use strict';

/**
 * R36 (#3491) — checkpoint lineage.
 *
 * A checkpoint is resumable state on disk, so the interesting cases are the
 * ones where the file was changed behind the run's back: an edited state blob,
 * a removed row, a reordered chain. Each must fail closed on restore, while a
 * row written before the hash columns existed must still resume.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HuqanStorage = require('../storage');
const {
  GENESIS_PREVIOUS_HASH,
  CHAIN_INVALID_REASONS,
  checkpointCanonicalPayload,
  appendCheckpointToChain,
  validateCheckpointChain,
} = require('../lib/storage/checkpoint-lineage');

function withStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-checkpoint-lineage-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'memory.db') });
  try {
    return fn(storage);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── the primitive ───────────────────────────────────────────────────────────

test('the canonical checkpoint payload covers durable content, not the storage clock', () => {
  const payload = checkpointCanonicalPayload({
    id: 'cp-1', goal_key: 'goal', goal: 'Goal', workspace_id: 'w', status: 'paused',
    iteration: 2, budget_remaining: 10, last_action: 'step', state_json: '{}', evidence_json: '[]',
    created_at: 111, updated_at: 222,
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'budget_remaining', 'evidence_json', 'goal', 'goal_key', 'id',
    'iteration', 'last_action', 'state_json', 'status', 'workspace_id',
  ]);
  assert.equal(payload.created_at, undefined, 'the clock is not content');
  assert.equal(payload.updated_at, undefined, 'the clock is not content');
});

test('the canonical checkpoint payload fails closed on a non-row input', () => {
  assert.throws(() => checkpointCanonicalPayload(null), /requires a checkpoint row/);
  assert.throws(() => checkpointCanonicalPayload('cp-1'), /requires a checkpoint row/);
});

test('appending a checkpoint links it to the previous hash and does not mutate the input', () => {
  const row = { id: 'cp-1', goal_key: 'g', goal: 'G', workspace_id: 'w', status: 'running' };
  const first = appendCheckpointToChain(row, undefined);
  assert.equal(first.previousReceiptHash, GENESIS_PREVIOUS_HASH);
  assert.equal(typeof first.receiptHash, 'string');
  assert.ok(first.receiptHash.length > 0);
  assert.equal(row.previousCheckpointHash, undefined, 'input stays untouched');

  const second = appendCheckpointToChain({ ...row, id: 'cp-2' }, first.receiptHash);
  assert.equal(second.previousReceiptHash, first.receiptHash);
  assert.deepEqual(validateCheckpointChain([first, second]), { valid: true, brokenAt: null, reason: null });
});

test('validateCheckpointChain reports content tampering and broken links distinctly', () => {
  const a = appendCheckpointToChain({ id: 'a', goal_key: 'g', goal: 'G', workspace_id: 'w', status: 'running' }, undefined);
  const b = appendCheckpointToChain({ id: 'b', goal_key: 'g', goal: 'G', workspace_id: 'w', status: 'running' }, a.receiptHash);

  const edited = { ...b, status: 'completed' };
  assert.equal(validateCheckpointChain([a, edited]).reason, CHAIN_INVALID_REASONS.CONTENT_TAMPERED);

  const dropped = validateCheckpointChain([b]);
  assert.equal(dropped.reason, CHAIN_INVALID_REASONS.GENESIS_MISMATCH, 'a first row not anchored on genesis is a mismatch');
});

test('the checkpoint chain has its own genesis marker, distinct from the receipt chain', () => {
  const { GENESIS_PREVIOUS_HASH: RECEIPT_GENESIS } = require('../lib/receipt/receipt-chain');
  assert.notEqual(
    GENESIS_PREVIOUS_HASH,
    RECEIPT_GENESIS,
    'a shared marker would let a checkpoint validate in a receipt chain position',
  );
});

// ─── the storage surface ─────────────────────────────────────────────────────

test('a saved checkpoint is stamped and its chain verifies', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', state: { step: 1 } });

  const row = storage.db.prepare('SELECT checkpoint_hash, previous_checkpoint_hash FROM checkpoints WHERE id = ?').get('cp-1');
  assert.ok(row.checkpoint_hash, 'a saved checkpoint carries a hash');
  assert.equal(row.previous_checkpoint_hash, GENESIS_PREVIOUS_HASH);

  const chain = storage.verifyCheckpointChain('G', 'w');
  assert.equal(chain.valid, true);
  assert.equal(chain.count, 1);
  assert.equal(storage.loadCheckpoint('cp-1', 'G', 'w').id, 'cp-1');
}));

test('consecutive checkpoints for a goal and workspace form a chain', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 1, state: { step: 1 } });
  storage.saveCheckpoint({ checkpointId: 'cp-2', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 2, state: { step: 2 } });

  const rows = storage.db.prepare('SELECT id, checkpoint_hash, previous_checkpoint_hash FROM checkpoints ORDER BY rowid').all();
  assert.equal(rows[1].previous_checkpoint_hash, rows[0].checkpoint_hash, 'the second links to the first');
  assert.equal(storage.verifyCheckpointChain('G', 'w').valid, true);
}));

test('tampering a checkpoint state blob is refused on load and detected by the chain', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', state: { step: 1 } });

  // Simulate an out-of-band edit: change the persisted state without re-hashing.
  storage.db.prepare('UPDATE checkpoints SET state_json = ? WHERE id = ?').run('{"step":999}', 'cp-1');

  assert.throws(
    () => storage.loadCheckpoint('cp-1', 'G', 'w'),
    (err) => err.code === 'CHECKPOINT_INTEGRITY_VIOLATION' && err.reason === CHAIN_INVALID_REASONS.CONTENT_TAMPERED,
    'tampered state must not hydrate',
  );
  assert.throws(() => storage.loadLatestCheckpoint('G', 'w'), (err) => err.code === 'CHECKPOINT_INTEGRITY_VIOLATION');

  const chain = storage.verifyCheckpointChain('G', 'w');
  assert.equal(chain.valid, false);
  assert.equal(chain.brokenAt, 0);
  assert.equal(chain.reason, CHAIN_INVALID_REASONS.CONTENT_TAMPERED);
}));

test('removing a checkpoint from the middle breaks the chain link', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 1, state: { step: 1 } });
  storage.saveCheckpoint({ checkpointId: 'cp-2', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 2, state: { step: 2 } });
  storage.saveCheckpoint({ checkpointId: 'cp-3', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 3, state: { step: 3 } });

  storage.db.prepare('DELETE FROM checkpoints WHERE id = ?').run('cp-2');

  const chain = storage.verifyCheckpointChain('G', 'w');
  assert.equal(chain.valid, false);
  assert.equal(chain.brokenAt, 1, 'the row that lost its predecessor');
  assert.equal(chain.reason, CHAIN_INVALID_REASONS.CHAIN_LINK_BROKEN);
}));

test('removing the first checkpoint of a chain is a genesis mismatch', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 1, state: { step: 1 } });
  storage.saveCheckpoint({ checkpointId: 'cp-2', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 2, state: { step: 2 } });

  storage.db.prepare('DELETE FROM checkpoints WHERE id = ?').run('cp-1');

  const chain = storage.verifyCheckpointChain('G', 'w');
  assert.equal(chain.valid, false);
  assert.equal(chain.reason, CHAIN_INVALID_REASONS.GENESIS_MISMATCH);
}));

test('an unstamped legacy checkpoint still loads and is not treated as tampering', () => withStorage((storage) => {
  // A row written before the hash columns existed: both hashes are the '' default.
  storage.db.prepare(`
    INSERT INTO checkpoints (id, goal_key, goal, state_json, iteration, budget_remaining,
      last_action, evidence_json, status, workspace_id, created_at, updated_at)
    VALUES ('legacy-1', 'g', 'G', '{"step":7}', 1, 0, '', '[]', 'paused', 'w', 1, 1)
  `).run();

  const loaded = storage.loadCheckpoint('legacy-1', 'G', 'w');
  assert.ok(loaded, 'a legacy row must still resume');
  assert.equal(loaded.state.step, 7);
  assert.equal(storage.verifyCheckpointChain('G', 'w').count, 0, 'unstamped rows are not part of the hashed chain');
}));

test('re-saving the same checkpoint id keeps it loadable and linked to its predecessor', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'cp-1', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 1, state: { step: 1 } });
  storage.saveCheckpoint({ checkpointId: 'cp-2', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 2, state: { step: 2 } });
  // The run advances and re-saves the same checkpoint id (the real loop does this).
  storage.saveCheckpoint({ checkpointId: 'cp-2', goal: 'G', workspaceId: 'w', status: 'paused', startedAtMs: 2, state: { step: 3 } });

  const loaded = storage.loadCheckpoint('cp-2', 'G', 'w');
  assert.ok(loaded, 'a re-saved checkpoint must still load');
  assert.equal(loaded.state.state.step, 3);
  assert.equal(storage.verifyCheckpointChain('G', 'w').valid, true, 'the re-save must not self-link or orphan');
}));

test('the checkpoint chain is scoped to one goal and workspace', () => withStorage((storage) => {
  storage.saveCheckpoint({ checkpointId: 'a-1', goal: 'G', workspaceId: 'w1', status: 'paused', startedAtMs: 1, state: {} });
  storage.saveCheckpoint({ checkpointId: 'a-2', goal: 'G', workspaceId: 'w1', status: 'paused', startedAtMs: 2, state: {} });
  storage.saveCheckpoint({ checkpointId: 'b-1', goal: 'G', workspaceId: 'w2', status: 'paused', startedAtMs: 1, state: {} });

  assert.equal(storage.verifyCheckpointChain('G', 'w1').count, 2);
  assert.equal(storage.verifyCheckpointChain('G', 'w2').count, 1);
  assert.equal(storage.verifyCheckpointChain('other', 'w1').count, 0);

  // A chain in a second workspace starts at genesis, not at w1's tip.
  const row = storage.db.prepare('SELECT previous_checkpoint_hash FROM checkpoints WHERE id = ?').get('b-1');
  assert.equal(row.previous_checkpoint_hash, GENESIS_PREVIOUS_HASH);
}));
