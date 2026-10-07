'use strict';

/**
 * Durable active-delegator cursor (R23, #3478).
 *
 * The exchange already persists per-request durability through
 * `lib/a2a/replay-store.js` (the reservation) and `lib/a2a/task-store.js`
 * (the completion), but neither answers "who holds the turn" after a
 * restart. This module adds that missing record: a bounded
 * `a2a-handoff-cursor` of `(from_agent_id, to_agent_id, route_receipt_id,
 * timestamp)` written next to the replay/task files in the same directory,
 * so no new table or database is introduced.
 *
 * Semantics mirror the stores it reuses:
 * - a cursor is written once with exclusive-create; a second write of the
 *   same bytes is idempotent, a second write of different bytes is the
 *   contradiction it is and leaves the first record standing;
 * - a closed cursor never reopens: `closeCursor` appends a separate
 *   `.handoff-terminated` file carrying the distinct termination reason
 *   resolved by `lib/a2a/handoff-termination.js`, and recording over a
 *   closed id refuses;
 * - a record this process cannot parse is reported corrupt, never resumed.
 *
 * Restart resume: a fresh store over the same directory reads the active
 * cursor back, which is the whole acceptance proof the issue asks for.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  TERMINATION_SCHEMA_VERSION,
  resolveHandoffTermination,
} = require('./handoff-termination');

const CURSOR_SCHEMA_VERSION = 'v5-a2a-handoff-cursor-v1';
// #3489: a cursor recorded with its handoff context carries the SHA-256 of
// that free text (never the text) and resumes only against the same text.
const CONTEXT_CURSOR_SCHEMA_VERSION = 'v5-a2a-handoff-cursor-v2';
const MAX_CONTEXT_BYTES = 65536;
const HASH = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_SUFFIX = '.handoff-cursor';
const TERMINATED_SUFFIX = '.handoff-terminated';
const MAX_ID_CHARS = 256;
const MAX_RECORD_BYTES = 2048;

function boundedId(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_ID_CHARS
    && Buffer.byteLength(value, 'utf8') <= MAX_ID_CHARS;
}

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

const CURSOR_FIELDS = ['from_agent_id', 'to_agent_id', 'route_receipt_id', 'timestamp'];

function boundedContext(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_CONTEXT_BYTES;
}

function contextHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function checkCursorFields(cursor) {
  return boundedId(cursor.from_agent_id)
    && boundedId(cursor.to_agent_id)
    && HASH.test(cursor.route_receipt_id)
    && INSTANT.test(cursor.timestamp);
}

// The four cursor fields, optionally with the free-text `handoff_context`
// the turn was handed over with. The shape stays exact so callers cannot
// smuggle other fields into a record.
function checkCursorShape(cursor) {
  if (exactKeys(cursor, CURSOR_FIELDS)) return checkCursorFields(cursor);
  return exactKeys(cursor, [...CURSOR_FIELDS, 'handoff_context'])
    && checkCursorFields(cursor)
    && boundedContext(cursor.handoff_context);
}

// The durable record carries the same fields plus its version discriminator;
// a v2 record also carries the context hash.
function checkStoredCursor(record) {
  if (record && record.schemaVersion === CURSOR_SCHEMA_VERSION) {
    return exactKeys(record, ['schemaVersion', ...CURSOR_FIELDS]) && checkCursorFields(record);
  }
  return exactKeys(record, ['schemaVersion', ...CURSOR_FIELDS, 'handoff_context_hash'])
    && record.schemaVersion === CONTEXT_CURSOR_SCHEMA_VERSION
    && checkCursorFields(record)
    && HASH.test(record.handoff_context_hash);
}

function writeOnce(target, payload) {
  if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('A2A handoff record too large');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJson(target) {
  let bytes;
  try {
    bytes = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    throw error;
  }
  try {
    return { present: true, value: JSON.parse(bytes), bytes };
  } catch (_) {
    return { present: true, corrupt: true };
  }
}

function createA2aHandoffCursor(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error('A2A handoff cursor directory must be a real directory');
  }

  return Object.freeze({ recordCursor, readCursor, resumeCursor, closeCursor });

  /**
   * Record the active delegator. Idempotent for identical bytes; a different
   * cursor under the same route receipt id is a conflict and the first
   * record stands. Recording over a terminated id refuses.
   */
  function recordCursor(cursor) {
    if (!checkCursorShape(cursor)) throw new Error('A2A handoff cursor is invalid');
    if (terminatedRecord(cursor.route_receipt_id)) {
      return Object.freeze({ recorded: false, reason: 'cursor_closed' });
    }
    const withContext = Object.hasOwn(cursor, 'handoff_context');
    const payload = JSON.stringify({
      schemaVersion: withContext ? CONTEXT_CURSOR_SCHEMA_VERSION : CURSOR_SCHEMA_VERSION,
      from_agent_id: cursor.from_agent_id,
      to_agent_id: cursor.to_agent_id,
      route_receipt_id: cursor.route_receipt_id,
      timestamp: cursor.timestamp,
      ...(withContext ? { handoff_context_hash: contextHash(cursor.handoff_context) } : {}),
    });
    const created = writeOnce(cursorPath(cursor.route_receipt_id), payload);
    if (created) return Object.freeze({ recorded: true });
    const existing = readJson(cursorPath(cursor.route_receipt_id));
    if (existing.bytes === payload) return Object.freeze({ recorded: true, duplicate: true });
    return Object.freeze({ recorded: false, reason: 'handoff_identity_conflict' });
  }

  /**
   * Read the cursor for a route receipt id.
   *
   * - `{ found: false }` — never recorded here;
   * - `{ found: true, active: true, cursor }` — the delegator still holds it;
   * - `{ found: true, active: false, cursor, termination }` — closed with its
   *   distinct reason;
   * - `{ found: true, active: false, corrupt: true }` — unreadable; never
   *   resumed, so a damaged record fails closed instead of looking active.
   */
  function readCursor(routeReceiptId) {
    if (!HASH.test(String(routeReceiptId || ''))) {
      return Object.freeze({ found: false });
    }
    const termination = terminatedRecord(routeReceiptId);
    const stored = readJson(cursorPath(routeReceiptId));
    if (!stored.present) {
      return Object.freeze({ found: false });
    }
    if (stored.corrupt) {
      return Object.freeze({ found: true, active: false, corrupt: true });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stored.bytes);
    } catch (_) {
      return Object.freeze({ found: true, active: false, corrupt: true });
    }
    const cursor = checkStoredCursor(parsed) ? parsed : null;
    if (!cursor) {
      return Object.freeze({ found: true, active: false, corrupt: true });
    }
    if (!termination) {
      return Object.freeze({ found: true, active: true, cursor: Object.freeze({ ...cursor }) });
    }
    return Object.freeze({
      found: true,
      active: false,
      cursor: Object.freeze({ ...cursor }),
      termination,
    });
  }

  /**
   * Close the handoff with its own termination reason. `closure` is
   * `{ handoffReason, closedBy, timestamp }`; the reason is resolved by the
   * termination allowlist, so an unknown wire reason or closer refuses the
   * close before anything is written. The first close stands.
   */
  /**
   * The resume decision, bound to evidence (#3489). A cursor recorded with
   * its handoff context resumes only when the same free text is presented:
   * missing or different text refuses. A v1 cursor has no recorded context,
   * so it resumes as before when none is presented, and refuses a context it
   * cannot check rather than pretending to have verified it.
   */
  function resumeCursor(routeReceiptId, { handoffContext } = {}) {
    const live = readCursor(routeReceiptId);
    if (!live.found) return Object.freeze({ resumable: false, reason: 'cursor_not_found' });
    if (live.corrupt) return Object.freeze({ resumable: false, reason: 'cursor_corrupt' });
    if (!live.active) return Object.freeze({ resumable: false, reason: 'cursor_closed', termination: live.termination });
    const recorded = live.cursor.handoff_context_hash;
    if (recorded === undefined) {
      if (handoffContext !== undefined) return Object.freeze({ resumable: false, reason: 'handoff_context_unrecorded' });
      return Object.freeze({ resumable: true, contextBound: false, cursor: live.cursor });
    }
    if (!boundedContext(handoffContext)) return Object.freeze({ resumable: false, reason: 'handoff_context_required' });
    if (contextHash(handoffContext) !== recorded) return Object.freeze({ resumable: false, reason: 'handoff_context_mismatch' });
    return Object.freeze({ resumable: true, contextBound: true, cursor: live.cursor });
  }

  function closeCursor(routeReceiptId, closure) {
    if (!HASH.test(String(routeReceiptId || ''))) throw new Error('A2A handoff cursor id is invalid');
    if (!closure || typeof closure !== 'object' || Array.isArray(closure)
        || !INSTANT.test(closure.timestamp)) {
      throw new Error('A2A handoff closure is invalid');
    }
    const resolved = resolveHandoffTermination(closure);
    const live = readCursor(routeReceiptId);
    if (!live.found || live.corrupt) {
      return Object.freeze({ closed: false, reason: 'cursor_not_found' });
    }
    if (!live.active) {
      return Object.freeze({ closed: false, reason: 'cursor_already_closed', termination: live.termination });
    }
    const payload = JSON.stringify({
      schemaVersion: TERMINATION_SCHEMA_VERSION,
      route_receipt_id: routeReceiptId,
      handoff_reason: resolved.handoffReason,
      termination_reason: resolved.terminationReason,
      closed_by: resolved.closedBy,
      timestamp: closure.timestamp,
    });
    const created = writeOnce(terminatedPath(routeReceiptId), payload);
    if (!created) {
      return Object.freeze({
        closed: false,
        reason: 'cursor_already_closed',
        termination: terminatedRecord(routeReceiptId),
      });
    }
    return Object.freeze({
      closed: true,
      termination: Object.freeze(JSON.parse(payload)),
    });
  }

  function cursorPath(routeReceiptId) {
    return path.join(root, `${routeReceiptId}${CURSOR_SUFFIX}`);
  }

  function terminatedPath(routeReceiptId) {
    return path.join(root, `${routeReceiptId}${TERMINATED_SUFFIX}`);
  }

  function terminatedRecord(routeReceiptId) {
    const stored = readJson(terminatedPath(routeReceiptId));
    if (!stored.present || stored.corrupt) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(stored.bytes);
    } catch (_) {
      return null;
    }
    if (!parsed || parsed.schemaVersion !== TERMINATION_SCHEMA_VERSION
        || parsed.route_receipt_id !== routeReceiptId) {
      return null;
    }
    return Object.freeze({ ...parsed });
  }
}

module.exports = Object.freeze({
  CURSOR_SCHEMA_VERSION,
  CONTEXT_CURSOR_SCHEMA_VERSION,
  CURSOR_SUFFIX,
  TERMINATED_SUFFIX,
  createA2aHandoffCursor,
});
