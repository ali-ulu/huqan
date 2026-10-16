'use strict';

/**
 * Experience Core E2 — ExperienceJournal tests (#2377).
 *
 * Hermetic unless noted: in-memory only, no I/O, no timers. The SQLite
 * cases use a temp file and skip when the driver is unavailable.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createExperienceJournal } = require('../lib/experience/journal');

function evt(overrides = {}) {
  return { runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started', ...overrides };
}

describe('E2 journal: E0-b RED behaviours go GREEN', () => {
  it('1. run isolation', () => {
    const j = createExperienceJournal();
    j.append(evt({ runId: 'runA', eventId: 'e1' }));
    assert.equal(j.read('runB', { workspaceId: 'ws' }).length, 0);
    assert.equal(j.read('runA', { workspaceId: 'ws' }).length, 1);
  });

  it('2. writer-supplied sequence is refused', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    const res = j.append(evt({ eventId: 'e2', type: 'action_proposed', sequence: 99 }));
    assert.equal(res.ok, false);
    assert.equal(j.read('r', { workspaceId: 'ws' }).length, 1);
  });

  it('3. attemptId stays bound to its first run', () => {
    const j = createExperienceJournal();
    j.append(evt({ runId: 'runA', eventId: 'e1', type: 'action_proposed', attemptId: 'att1', invocationId: 'inv1' }));
    const clash = j.append(evt({ runId: 'runB', eventId: 'e2', type: 'action_proposed', attemptId: 'att1', invocationId: 'inv2' }));
    assert.equal(clash.ok, false);
    assert.deepEqual(j.runsForAttempt('att1'), ['runA']);
  });

  it('4. idempotent retry reports duplicate, stores once', () => {
    const j = createExperienceJournal();
    j.append(evt());
    const second = j.append(evt());
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.sequence, 1);
    assert.equal(j.read('r', { workspaceId: 'ws' }).length, 1);
  });

  it('5a. same eventId with different payload conflicts', () => {
    const j = createExperienceJournal();
    j.append(evt({ type: 'action_proposed', payload: { a: 1 } }));
    const res = j.append(evt({ type: 'action_proposed', payload: { a: 2 } }));
    assert.equal(res.ok, false);
  });

  it('5b. stale expected-head conflicts, fresh head succeeds', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    const first = j.append(evt({ eventId: 'e2', type: 'action_proposed' }), { expectedHead: 1 });
    assert.equal(first.ok, true);
    const stale = j.append(evt({ eventId: 'e3', type: 'action_proposed' }), { expectedHead: 1 });
    assert.equal(stale.ok, false);
    const fresh = j.append(evt({ eventId: 'e3', type: 'action_proposed' }), { expectedHead: 2 });
    assert.equal(fresh.ok, true);
  });

  it('6. closed runs refuse appends, even with a stale handle', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    j.close('r');
    assert.equal(j.append(evt({ eventId: 'e2', type: 'action_proposed' })).ok, false);
  });

  it('6b. run_closed event closes the run', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    assert.equal(j.append(evt({ eventId: 'e9', type: 'run_closed' })).ok, true);
    assert.equal(j.append(evt({ eventId: 'e2', type: 'action_proposed' })).ok, false);
  });

  it('7. missing outcome stays unknown and ineligible', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    j.append(evt({ eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' }));
    const m = j.manifest('r');
    assert.equal(m.outcomeStatus, 'unknown');
    assert.equal(m.learningEligibility, 'ineligible');
  });

  it('8. workspace isolation', () => {
    const j = createExperienceJournal();
    j.append(evt({ workspaceId: 'ws1' }));
    assert.equal(j.read('r', { workspaceId: 'ws2' }).length, 0);
    assert.equal(j.read('r', { workspaceId: 'ws1' }).length, 1);
  });

  it('9. cross-run causality refused, parent link recorded', () => {
    const j = createExperienceJournal();
    j.append(evt({ runId: 'runA', eventId: 'e1' }));
    const cross = j.append(evt({ runId: 'runB', eventId: 'e2', type: 'action_proposed', causedByEventId: 'e1' }));
    assert.equal(cross.ok, false);
    j.append(evt({ runId: 'child', eventId: 'e3', parentRunId: 'parent' }));
    assert.equal(j.parentOf('child'), 'parent');
  });

  it('9b. same-run causality resolves', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    const res = j.append(evt({ eventId: 'e2', type: 'action_proposed', causedByEventId: 'e1' }));
    assert.equal(res.ok, true);
  });

  it('10. completed alone never verifies', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    j.append(evt({ eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' }));
    assert.notEqual(j.manifest('r').outcomeStatus, 'verified');
  });

  it('verified run with full proofs is positive_procedure', () => {
    const j = createExperienceJournal();
    j.append(evt({ eventId: 'e1' }));
    j.append(evt({ eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' }));
    j.append(evt({
      eventId: 'e3', type: 'verification', verdict: 'verified',
      proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
    }));
    const m = j.manifest('r');
    assert.equal(m.outcomeStatus, 'verified');
    assert.equal(m.learningEligibility, 'positive_procedure');
  });
});

describe('E2 journal: failure and integrity behaviour', () => {
  it('a store that cannot write fails closed without touching memory', () => {
    const j = createExperienceJournal({
      store: { withTransaction() { throw new Error('disk gone'); } },
    });
    const res = j.append(evt());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'persist_failed');
  });

  it('appends commit inside the store transaction', () => {
    let txns = 0;
    const j = createExperienceJournal({
      store: { withTransaction: (fn) => { txns += 1; return fn(); } },
    });
    assert.equal(j.append(evt()).ok, true);
    assert.equal(txns, 1);
  });

  it('a record altered outside the journal is refused on read (SQLite)', (t) => {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (_) {
      t.skip('better-sqlite3 unavailable');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-journal-'));
    const dbPath = path.join(dir, 'exp.db');
    const db = new Database(dbPath);
    try {
      const store = { db, withTransaction: (fn) => db.transaction(fn)() };
      createExperienceJournal({ store }).append(evt());
      db.prepare("UPDATE experience_journal SET body = ? WHERE run_id = 'r'")
        .run('{"runId":"r","forged":true}');
      // The live instance still holds its verified copy; a fresh instance
      // rebuilding from the store must refuse the tampered row on read.
      const reopened = createExperienceJournal({ store });
      assert.throws(() => reopened.read('r', { workspaceId: 'ws' }),
        (err) => err && err.code === 'INTEGRITY_MISMATCH');
    } finally {
      try { db.close(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('acknowledged appends survive a restart (SQLite)', (t) => {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch (_) {
      t.skip('better-sqlite3 unavailable');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-journal-'));
    const dbPath = path.join(dir, 'exp.db');
    const open = () => {
      const db = new Database(dbPath);
      return { db, store: { db, withTransaction: (fn) => db.transaction(fn)() } };
    };
    try {
      const first = open();
      createExperienceJournal({ store: first.store }).append(evt());
      createExperienceJournal({ store: first.store })
        .append(evt({ eventId: 'e2', type: 'action_proposed' }));
      first.db.close();
      const second = open();
      try {
        const events = createExperienceJournal({ store: second.store })
          .read('r', { workspaceId: 'ws' });
        assert.equal(events.length, 2);
        assert.deepEqual(events.map((e) => e.sequence), [1, 2]);
      } finally {
        second.db.close();
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});

describe('E2 journal: rolled-back append never reaches memory (#2894)', () => {
  // A store whose transaction rolls the insert back after the callback has
  // run: SQLite drops the row, so the journal must not have recorded it.
  const rollingBack = (dir, label) => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'exp.db'));
    const store = {
      db,
      withTransaction: (fn) => db.transaction(() => { fn(); throw new Error(label); })(),
    };
    return { db, store };
  };

  const withDb = (t, body) => {
    try {
      require('better-sqlite3');
    } catch (_) {
      t.skip('better-sqlite3 unavailable');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-exp-rollback-'));
    try {
      body(dir);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  };

  it('a rolled-back first append leaves zero durable rows and zero memory', (t) => {
    withDb(t, (dir) => {
      const { db, store } = rollingBack(dir, 'forced rollback');
      try {
        const j = createExperienceJournal({ store });
        const res = j.append(evt());
        assert.equal(res.ok, false);
        assert.equal(res.code, 'persist_failed');
        assert.equal(db.prepare('SELECT count(*) AS n FROM experience_journal').get().n, 0);
        assert.equal(j.manifest('r').eventCount, 0);
        assert.equal(j.manifest('r').head, 0);
        assert.equal(j.read('r', { workspaceId: 'ws' }).length, 0);
      } finally { db.close(); }
    });
  });

  it('a retry after the rollback writes sequence 1', (t) => {
    withDb(t, (dir) => {
      let roll = true;
      const Database = require('better-sqlite3');
      const db = new Database(path.join(dir, 'exp.db'));
      const store = {
        db,
        withTransaction: (fn) => (roll
          ? db.transaction(() => { fn(); throw new Error('forced rollback'); })()
          : db.transaction(fn)()),
      };
      try {
        const j = createExperienceJournal({ store });
        assert.equal(j.append(evt()).ok, false);
        roll = false;
        const retry = j.append(evt());
        assert.equal(retry.ok, true);
        assert.equal(retry.sequence, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM experience_journal').get().n, 1);
      } finally { db.close(); }
    });
  });

  it('a rollback after one committed event keeps the committed head', (t) => {
    withDb(t, (dir) => {
      let roll = false;
      const Database = require('better-sqlite3');
      const db = new Database(path.join(dir, 'exp.db'));
      const store = {
        db,
        withTransaction: (fn) => (roll
          ? db.transaction(() => { fn(); throw new Error('forced rollback'); })()
          : db.transaction(fn)()),
      };
      try {
        const j = createExperienceJournal({ store });
        assert.equal(j.append(evt()).ok, true);
        roll = true;
        const res = j.append(evt({ eventId: 'e2', type: 'action_proposed' }));
        assert.equal(res.code, 'persist_failed');
        assert.equal(db.prepare('SELECT count(*) AS n FROM experience_journal').get().n, 1);
        assert.equal(j.manifest('r').eventCount, 1);
        assert.equal(j.manifest('r').head, 1);
      } finally { db.close(); }
    });
  });

  it('a rolled-back run_closed leaves the run open', (t) => {
    withDb(t, (dir) => {
      let roll = false;
      const Database = require('better-sqlite3');
      const db = new Database(path.join(dir, 'exp.db'));
      const store = {
        db,
        withTransaction: (fn) => (roll
          ? db.transaction(() => { fn(); throw new Error('forced rollback'); })()
          : db.transaction(fn)()),
      };
      try {
        const j = createExperienceJournal({ store });
        j.append(evt());
        roll = true;
        const res = j.append(evt({ eventId: 'e2', type: 'run_closed' }));
        assert.equal(res.code, 'persist_failed');
        assert.equal(j.manifest('r').closed, false);
        assert.equal(j.append(evt({ eventId: 'e3', type: 'action_proposed' })).ok, false);
        roll = false;
        assert.equal(j.append(evt({ eventId: 'e3', type: 'action_proposed' })).ok, true);
      } finally { db.close(); }
    });
  });
});
