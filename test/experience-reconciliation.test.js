'use strict';

/**
 * Experience E5 — crash recovery and reconciliation tests (#2399).
 *
 * Hermetic unless noted: in-memory only. SQLite cases use a temp file and
 * skip when the driver is unavailable.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createOperationLedger } = require('../lib/experience/reconciliation');

function tempStore() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_) {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-recon-'));
  const db = new Database(path.join(dir, 'ops.db'));
  return { dir, db, store: { db, withTransaction: (fn) => db.transaction(fn)() } };
}

function closeTemp(t) {
  try { t.db.close(); } catch (_) {}
  try { fs.rmSync(t.dir, { recursive: true, force: true }); } catch (_) {}
}

describe('E5: intent before effect', () => {
  it('begin records pending intent; claim replays it without work', () => {
    const ledger = createOperationLedger();
    const res = ledger.begin({ operationId: 'op1', runId: 'run-1', workspaceId: 'ws', intent: { url: 'https://x' } });
    assert.equal(res.ok, true);
    assert.equal(res.state, 'pending');
    assert.deepEqual(ledger.claim('op1'), { ok: true, state: 'pending', outcome: null });
  });

  it('same intent retried is a duplicate, stored once', () => {
    const ledger = createOperationLedger();
    ledger.begin({ operationId: 'op1', runId: 'run-1', intent: { a: 1 } });
    const second = ledger.begin({ operationId: 'op1', runId: 'run-1', intent: { a: 1 } });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
  });

  it('same operation ID with a different intent conflicts', () => {
    const ledger = createOperationLedger();
    ledger.begin({ operationId: 'op1', runId: 'run-1', intent: { a: 1 } });
    assert.deepEqual(ledger.begin({ operationId: 'op1', runId: 'run-1', intent: { a: 2 } }),
      { ok: false, code: 'operation_conflict' });
    assert.deepEqual(ledger.begin({ operationId: 'op1', runId: 'run-2', intent: { a: 1 } }),
      { ok: false, code: 'operation_conflict' });
  });

  it('a failed append means no effect may happen', () => {
    const ledger = createOperationLedger({
      store: { withTransaction() { throw new Error('disk gone'); } },
    });
    assert.deepEqual(ledger.begin({ operationId: 'op1', runId: 'run-1' }),
      { ok: false, code: 'persist_failed' });
    assert.deepEqual(ledger.claim('op1'), { ok: false, code: 'unknown_operation' });
  });
});

describe('E5: outcomes and replays', () => {
  it('complete records the outcome; replays return it', () => {
    const ledger = createOperationLedger();
    ledger.begin({ operationId: 'op1', runId: 'run-1' });
    assert.deepEqual(ledger.complete({ operationId: 'op1', outcome: { status: 200 } }),
      { ok: true, state: 'completed' });
    assert.deepEqual(ledger.claim('op1'), { ok: true, state: 'completed', outcome: { status: 200 } });
  });

  it('completed operations cannot transition again', () => {
    const ledger = createOperationLedger();
    ledger.begin({ operationId: 'op1', runId: 'run-1' });
    ledger.complete({ operationId: 'op1', outcome: 1 });
    assert.deepEqual(ledger.complete({ operationId: 'op1', outcome: 2 }),
      { ok: false, code: 'bad_transition' });
    assert.deepEqual(ledger.claim('op1').outcome, 1);
  });

  it('unknown operations stay unknown', () => {
    const ledger = createOperationLedger();
    assert.deepEqual(ledger.claim('nope'), { ok: false, code: 'unknown_operation' });
    assert.deepEqual(ledger.complete({ operationId: 'nope' }), { ok: false, code: 'unknown_operation' });
  });
});

describe('E5: restart and crash recovery (SQLite)', () => {
  it('pending intents survive a restart as unknown, completed ones keep outcomes', (t) => {
    const tmp = tempStore();
    if (!tmp) { t.skip('better-sqlite3 unavailable'); return; }
    try {
      const first = createOperationLedger({ store: tmp.store });
      first.begin({ operationId: 'op-pending', runId: 'run-1', intent: { a: 1 } });
      first.begin({ operationId: 'op-done', runId: 'run-1', intent: { b: 2 } });
      first.complete({ operationId: 'op-done', outcome: { ok: true } });
      tmp.db.close();

      const db2 = require('better-sqlite3')(path.join(tmp.dir, 'ops.db'));
      const second = createOperationLedger({
        store: { db: db2, withTransaction: (fn) => db2.transaction(fn)() },
      });
      try {
        assert.deepEqual(second.reconcile(), [{
          operationId: 'op-pending', runId: 'run-1', workspaceId: 'default', state: 'unknown',
        }]);
        assert.deepEqual(second.claim('op-done'),
          { ok: true, state: 'completed', outcome: { ok: true } });
      } finally {
        db2.close();
      }
      tmp.db = { close() {} };
    } finally {
      closeTemp(tmp);
    }
  });

  it('two writers racing one operation ID leave one winner, no duplicates', (t) => {
    const tmp = tempStore();
    if (!tmp) { t.skip('better-sqlite3 unavailable'); return; }
    try {
      const a = createOperationLedger({ store: tmp.store });
      const b = createOperationLedger({ store: tmp.store });
      assert.equal(a.begin({ operationId: 'op1', runId: 'run-1', intent: { x: 1 } }).ok, true);
      const retry = b.begin({ operationId: 'op1', runId: 'run-1', intent: { x: 1 } });
      assert.equal(retry.ok, true);
      assert.equal(retry.duplicate, true);
      const clash = b.begin({ operationId: 'op1', runId: 'run-9', intent: { x: 1 } });
      assert.equal(clash.ok, false);
    } finally {
      closeTemp(tmp);
    }
  });

  it('a kill at any instant leaves no torn rows', (t) => {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (_) {
      t.skip('better-sqlite3 unavailable');
      return;
    }
    void Database;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-kill-'));
    const dbPath = path.join(dir, 'ops.db');
    const repoRoot = path.join(__dirname, '..');
    const worker = `
      const { createOperationLedger } = require(${JSON.stringify(path.join(repoRoot, 'lib', 'experience', 'reconciliation.js'))});
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(dbPath)});
      const ledger = createOperationLedger({ store: { db, withTransaction: (fn) => db.transaction(fn)() } });
      for (let i = 0; i < 5000; i += 1) {
        ledger.begin({ operationId: 'op-' + i, runId: 'run-kill', intent: { i } });
        if (i % 2 === 0) ledger.complete({ operationId: 'op-' + i, outcome: { i } });
      }
    `;
    const child = require('node:child_process').spawn(process.execPath, ['-e', worker], { stdio: 'ignore' });
    setTimeout(() => child.kill('SIGKILL'), 150).unref?.();
    child.on('exit', () => {});
    const waited = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { timeout: 5000 });
    void waited;
    const check = spawnSync(process.execPath, ['-e', `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(dbPath)});
      try {
        const rows = db.prepare("SELECT operation_id, state, intent_body, outcome_body FROM experience_operations").all();
        let bad = 0;
        for (const r of rows) {
          try { JSON.parse(r.intent_body); } catch (_) { bad += 1; }
          if (r.outcome_body != null) { try { JSON.parse(r.outcome_body); } catch (_) { bad += 1; } }
          if (r.state !== 'pending' && r.state !== 'completed' && r.state !== 'failed') bad += 1;
        }
        if (bad > 0) { console.error('torn rows: ' + bad); process.exit(1); }
      } catch (err) {
        if (!/no such table/i.test(String(err && err.message))) throw err;
      }
    `], { timeout: 10000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    assert.equal(check.status, 0, check.stderr.toString());
  });
});

describe('E5: late outcomes never mutate closed runs', () => {
  it('open runs take the outcome; closed runs get a linked run plan', () => {
    const ledger = createOperationLedger();
    ledger.begin({ operationId: 'op1', runId: 'run-1', workspaceId: 'ws' });
    assert.deepEqual(ledger.lateOutcome({ operationId: 'op1', outcome: { ok: true } }),
      { ok: true, action: 'append-outcome', runId: 'run-1', outcome: { ok: true } });
    assert.deepEqual(
      ledger.lateOutcome({ operationId: 'op1', outcome: { ok: true }, runClosed: true }),
      {
        ok: true, action: 'open-linked-run', parentRunId: 'run-1',
        workspaceId: 'ws', outcome: { ok: true },
      });
  });
});
