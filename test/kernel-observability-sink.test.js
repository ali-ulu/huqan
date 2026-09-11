'use strict';

/**
 * Gate telemetry must actually land somewhere.
 *
 * `emitGateTelemetry()` is called on every MCP tool call, every memory
 * admission, every agent firewall decision and every agent loop budget check.
 * It writes through `kernel?.observability?.recordGateDecision?.()` inside a
 * `try { ... } catch (_) {}` -- three optional links and a swallowed error. If
 * nothing ever assigns `kernel.observability`, every one of those calls is a
 * silent no-op and no test notices, because the call itself still "succeeds".
 *
 * That is what had happened. The only non-benchmark assignment in the tree was
 * in lib/observability/server-runtime.js, inside a lazy getService() whose sole
 * caller is server.js -- so the MCP process and the CLI never had a sink. The
 * live operator store proves the consequence: 246 audit events, 131 approvals
 * and 61 learn events, with `observability_events` empty and the observability
 * schema already migrated. The evidence that would answer "has this capability
 * ever run?" was being produced and dropped.
 *
 * These tests hold the wire in place: the sink exists by default, a real
 * decision reaches the database file, and the instrumentation start is stamped
 * so the absence of older rows is never read as proof of disuse.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { KernelV2 } = require('../index.js');
const {
  INSTRUMENTED_SINCE_KEY,
  readInstrumentedSince,
} = require('../lib/observability/instrumentation-marker');

let Database = null;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function scratchDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-obs-sink-'));
  return path.join(dir, 'memory.db');
}

// A store nothing has emitted into yet has no observability schema at all: the
// sink is built on first read, so "the table is missing" and "the table is
// empty" are the same answer -- nothing has been recorded.
function countEvents(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS total FROM observability_events').get().total;
  } catch (error) {
    if (/no such table/i.test(error.message)) return 0;
    throw error;
  } finally {
    db.close();
  }
}

test('a kernel has an observability sink without anyone attaching one', { skip: !Database }, () => {
  const dbPath = scratchDb();
  const kernel = new KernelV2({ dbPath });

  assert.equal(typeof kernel.observability?.recordGateDecision, 'function');
});

// The assertion that matters is the row on disk, not the presence of a method:
// a sink that is wired but writes nowhere is the same outage with a nicer shape.
test('a gate decision made through the public API reaches the database file', { skip: !Database }, () => {
  const dbPath = scratchDb();
  const kernel = new KernelV2({ dbPath });

  assert.equal(countEvents(dbPath), 0, 'no decision has been made yet');
  kernel.learn('The sink records that this admission was evaluated.');

  assert.ok(countEvents(dbPath) > 0, 'the memory admission decision was dropped');
});

// Without this stamp the first report after wiring would call every capability
// NEVER USED, which is the exact error the usage report exists to prevent:
// reading silence as proof of disuse.
test('the instrumentation start is stamped, and does not move on reopen', { skip: !Database }, () => {
  const dbPath = scratchDb();
  new KernelV2({ dbPath }).learn('first');
  const first = readInstrumentedSince(dbPath);

  assert.match(String(first), /^\d{4}-\d{2}-\d{2}T/);

  new KernelV2({ dbPath }).learn('second');

  assert.equal(readInstrumentedSince(dbPath), first, 'reopening must not restamp the store');
  assert.equal(INSTRUMENTED_SINCE_KEY, 'capability_usage_instrumented_since');
});

// server.js builds its own service with the HTTP runtime's configuration and
// assigns it. The default must be a plain, replaceable property, not a getter
// that makes that assignment throw.
test('the server runtime can still replace the default sink', { skip: !Database }, () => {
  const kernel = new KernelV2({ dbPath: scratchDb() });
  const replacement = { recordGateDecision() {} };

  kernel.observability = replacement;

  assert.equal(kernel.observability, replacement);
});

// A store with no SQLite handle -- JSON mode, or better-sqlite3 unavailable --
// has nowhere to write. Telemetry stays a no-op there, and it must say so by
// being absent rather than by pretending to record.
test('a kernel with no SQLite handle has no sink and still works', () => {
  const kernel = new KernelV2({ useSQLite: false, memoryPath: path.join(os.tmpdir(), 'huqan-obs-json.json') });

  assert.equal(kernel.observability, null);
  assert.doesNotThrow(() => kernel.learn('json mode still learns'));
});
