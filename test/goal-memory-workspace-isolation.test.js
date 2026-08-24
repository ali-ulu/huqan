const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const HuqanStorage = require('../storage');
const { applyStorageSchema } = require('../lib/storage/schema');

let tempDir;
let counter = 0;
const storages = new Set();

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-goal-memory-'));
});

after(() => {
  for (const storage of storages) {
    try { storage.close(); } catch (_) {}
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * `memoryPath` is passed alongside `dbPath` deliberately.
 *
 * storage.js#resolveDbPath allows process.cwd() plus the directory of any
 * supplied memoryPath. Without it a tmpdir dbPath falls outside every allowed
 * root and resolveContainedPath silently redirects the handle to a hashed file
 * under /tmp/axiom-safe-paths -- so the test would open a different database
 * than the one it wrote, and a stale file could survive between runs. Naming a
 * memoryPath in the same directory makes tempDir an allowed root, so the
 * fixture actually reads back what it wrote.
 */
function storageAt(dbPath) {
  const storage = new HuqanStorage({ dbPath, memoryPath: path.join(path.dirname(dbPath), 'memory.json') });
  storages.add(storage);
  return storage;
}

function makeStorage(name) {
  return storageAt(path.join(tempDir, `${name}-${counter++}.db`));
}

const GOAL = 'kedi hakkinda arastir';

describe('goal memory is workspace-scoped (#757)', () => {
  it('each workspace reads only its own record', () => {
    const storage = makeStorage('scoped');
    storage.saveGoalMemory({
      goal: GOAL, workspaceId: 'tenant-a', status: 'completed', finalAnswer: 'answer-A',
    });
    storage.saveGoalMemory({
      goal: GOAL, workspaceId: 'tenant-b', status: 'blocked', finalAnswer: 'answer-B',
    });

    const a = storage.getGoalMemory(GOAL, 'tenant-a');
    const b = storage.getGoalMemory(GOAL, 'tenant-b');

    assert.strictEqual(a.last_status, 'completed');
    assert.strictEqual(b.last_status, 'blocked');
    assert.strictEqual(a.pattern.lastFinalAnswer, 'answer-A');
    assert.strictEqual(b.pattern.lastFinalAnswer, 'answer-B');
    assert.strictEqual(a.workspace_id, 'tenant-a');
    assert.strictEqual(b.workspace_id, 'tenant-b');
  });

  it('counts do not accumulate across workspaces', () => {
    const storage = makeStorage('counts');
    for (let i = 0; i < 3; i++) {
      storage.saveGoalMemory({ goal: GOAL, workspaceId: 'tenant-a', status: 'completed' });
    }
    storage.saveGoalMemory({ goal: GOAL, workspaceId: 'tenant-b', status: 'completed' });

    assert.strictEqual(storage.getGoalMemory(GOAL, 'tenant-a').success_count, 3);
    assert.strictEqual(storage.getGoalMemory(GOAL, 'tenant-b').success_count, 1);
  });

  it('a workspace with no history sees nothing', () => {
    const storage = makeStorage('absent');
    storage.saveGoalMemory({ goal: GOAL, workspaceId: 'tenant-a', status: 'completed' });
    assert.strictEqual(storage.getGoalMemory(GOAL, 'tenant-unseen'), null);
  });

  it('the default workspace is its own scope, not a global one', () => {
    const storage = makeStorage('default-scope');
    storage.saveGoalMemory({ goal: GOAL, workspaceId: 'tenant-a', status: 'completed' });
    assert.strictEqual(storage.getGoalMemory(GOAL), null);
    assert.strictEqual(storage.getGoalMemory(GOAL, 'default'), null);

    storage.saveGoalMemory({ goal: GOAL, status: 'error' });
    assert.strictEqual(storage.getGoalMemory(GOAL, 'default').last_status, 'error');
    assert.strictEqual(storage.getGoalMemory(GOAL, 'tenant-a').last_status, 'completed');
  });

  it('countGoals can be scoped, and stays global when unscoped', () => {
    const storage = makeStorage('count-goals');
    storage.saveGoalMemory({ goal: 'goal one', workspaceId: 'tenant-a', status: 'completed' });
    storage.saveGoalMemory({ goal: 'goal two', workspaceId: 'tenant-a', status: 'completed' });
    storage.saveGoalMemory({ goal: 'goal one', workspaceId: 'tenant-b', status: 'completed' });

    assert.strictEqual(storage.countGoals('tenant-a'), 2);
    assert.strictEqual(storage.countGoals('tenant-b'), 1);
    assert.strictEqual(storage.countGoals(), 3);
  });
});

describe('legacy goal-memory rows migrate into the default workspace (#757)', () => {
  it('a pre-migration row stays readable, and only from default', () => {
    const dbPath = path.join(tempDir, `legacy-${counter++}.db`);

    // Build the pre-migration shape: no workspace_id, key is the bare goal.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE goal_memory (
        key TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT 'investigate',
        success_count INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        resumed_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        pattern_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`INSERT INTO goal_memory
      (key, goal, objective, success_count, last_status, pattern_json, created_at, updated_at)
      VALUES (?, ?, 'investigate', 7, 'completed', '{"lastFinalAnswer":"legacy-answer"}', 1, 1)`)
      .run(GOAL.toLowerCase(), GOAL);
    legacy.close();

    // Opening through the real storage path applies the migration.
    const storage = storageAt(dbPath);
    const migrated = storage.getGoalMemory(GOAL, 'default');
    assert.ok(migrated, 'legacy history was lost by the migration');
    assert.strictEqual(migrated.success_count, 7);
    assert.strictEqual(migrated.pattern.lastFinalAnswer, 'legacy-answer');

    // ...and it did not become visible to any other workspace.
    assert.strictEqual(storage.getGoalMemory(GOAL, 'tenant-a'), null);
  });

  it('the migration is idempotent across reopens', () => {
    const dbPath = path.join(tempDir, `idempotent-${counter++}.db`);
    const first = storageAt(dbPath);
    first.saveGoalMemory({ goal: GOAL, workspaceId: 'tenant-a', status: 'completed' });

    const reopened = storageAt(dbPath);
    const record = reopened.getGoalMemory(GOAL, 'tenant-a');
    assert.ok(record, 'reopening re-applied the backfill and lost the row');
    assert.strictEqual(record.success_count, 1);
  });

  it('applyStorageSchema reports the added column once', () => {
    const dbPath = path.join(tempDir, `added-${counter++}.db`);
    const db = new Database(dbPath);
    const first = applyStorageSchema(db);
    const second = applyStorageSchema(db);
    assert.ok(!second.addedColumns.includes('goal_memory.workspace_id'),
      'a second migration pass re-added the column');
    db.close();
    assert.ok(Array.isArray(first.addedColumns));
  });
});
