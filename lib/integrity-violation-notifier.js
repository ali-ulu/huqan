'use strict';

// Siren for emergency-stop integrity violations (#2591, follows #2584).
//
// The ledger records tampering durably, but nothing reads it proactively:
// check() stays a synchronous hot path with no network side effects. This
// module is the explicit, operator-invoked siren over that record.
//
// Non-closable by construction: there is no enable/mute/type-filter option.
// Every integrity_violation ledger entry produces exactly one notification
// attempt (a cursor file records the last notified seq). When no adapter is
// configured the failure is returned loudly -- never thrown, never silent.
//
// Transport is unchanged: the caller's adapter (the same HTTPS webhook with
// HMAC, bounded retries and redacted payloads from
// lib/observability/notification-adapter.js) does the sending; this module
// only builds the payload and tracks the cursor.

const fs = require('node:fs');
const path = require('node:path');

const INTEGRITY_VIOLATION_TYPE = 'integrity_violation';
const CURSOR_FILE = 'notify-cursor.json';
const MAX_TEXT = 256;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

function cursorPathFor(ledgerDirectory, override) {
  if (typeof override === 'string' && override) return path.resolve(override);
  return path.join(path.resolve(ledgerDirectory || '.'), CURSOR_FILE);
}

function readCursor(cursorPath) {
  let raw;
  try {
    raw = fs.readFileSync(cursorPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { lastNotifiedSeq: -1 };
    return { lastNotifiedSeq: -1, unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    const seq = Number(parsed && parsed.lastNotifiedSeq);
    if (!Number.isInteger(seq) || seq < -1) return { lastNotifiedSeq: -1, unreadable: true };
    return { lastNotifiedSeq: seq };
  } catch (_) {
    return { lastNotifiedSeq: -1, unreadable: true };
  }
}

function writeCursor(cursorPath, lastNotifiedSeq) {
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify({ lastNotifiedSeq }), 'utf8');
}

function buildIntegrityViolationNotification(entry, workspaceId) {
  const seq = Number(entry.seq);
  const hash = String(entry.hash || '');
  return Object.freeze({
    notificationId: `integrity-violation-${Number.isInteger(seq) ? seq : 'x'}-${hash.slice(0, 12) || 'unknown'}`,
    type: INTEGRITY_VIOLATION_TYPE,
    workspaceId: text(workspaceId || entry.workspaceId) || 'default',
    alert: Object.freeze({
      alertId: `integrity-violation-${Number.isInteger(seq) ? seq : 'x'}`,
      ruleId: 'emergency-stop-integrity',
      workspaceId: text(workspaceId || entry.workspaceId) || 'default',
      status: 'firing',
      fingerprint: hash.slice(0, 128),
      eventId: hash.slice(0, 128),
      firedAt: entry.createdAt || null,
    }),
    metadata: Object.freeze({
      scope: entry.scope || null,
      ledgerSeq: Number.isInteger(seq) ? seq : null,
      ledgerHash: hash || null,
      violationReason: text(entry.reason),
    }),
  });
}

/**
 * Notify every integrity_violation ledger entry not yet covered by the cursor.
 *
 * @param {object} emergencyStop a ledger with listIntegrityViolations() and directory
 * @param {function} notify async (notification) => result; when absent the
 *   failure is returned as data ({ ok:false, reason:'no_notification_adapter_configured' })
 * @returns {object} { ok, notified, failures, violations } -- never throws for
 *   transport problems; only a missing/invalid ledger object throws TypeError.
 */
async function notifyIntegrityViolations({ emergencyStop, notify, cursorPath, workspaceId } = {}) {
  if (!emergencyStop || typeof emergencyStop.listIntegrityViolations !== 'function') {
    throw new TypeError('an emergency stop ledger with listIntegrityViolations is required');
  }
  const violations = emergencyStop.listIntegrityViolations();
  const cursorFile = cursorPathFor(emergencyStop.directory, cursorPath);
  const cursor = readCursor(cursorFile);
  const pending = violations.filter((entry) => Number.isInteger(entry.seq) && entry.seq > cursor.lastNotifiedSeq);
  if (typeof notify !== 'function') {
    return Object.freeze({
      ok: false,
      notified: 0,
      failures: pending.map((entry) => ({ seq: entry.seq, reason: 'no_notification_adapter_configured' })),
      violations,
      cursorUnreadable: Boolean(cursor.unreadable),
    });
  }
  const failures = [];
  let notified = 0;
  let highWater = cursor.lastNotifiedSeq;
  for (const entry of pending) {
    const notification = buildIntegrityViolationNotification(entry, workspaceId);
    let result;
    try {
      result = await notify(notification);
    } catch (error) {
      result = { ok: false, code: 'NOTIFICATION_FAILED', message: String(error && error.message || error) };
    }
    if (result && result.ok === true) {
      notified += 1;
      highWater = Math.max(highWater, entry.seq);
    } else {
      failures.push({ seq: entry.seq, reason: String((result && (result.code || result.reason)) || 'delivery_failed') });
      break;
    }
  }
  if (highWater > cursor.lastNotifiedSeq) writeCursor(cursorFile, highWater);
  return Object.freeze({
    ok: failures.length === 0,
    notified,
    failures: Object.freeze(failures),
    violations,
    cursorUnreadable: Boolean(cursor.unreadable),
  });
}

module.exports = {
  INTEGRITY_VIOLATION_TYPE,
  INTEGRITY_VIOLATION_CURSOR_FILE: CURSOR_FILE,
  buildIntegrityViolationNotification,
  notifyIntegrityViolations,
};
