'use strict';

/**
 * #4135 — the local usage and approval-fatigue signal for `huqan doctor`.
 *
 * Two risks the product could not see before this check:
 *
 * 1. A gate that no agent ever calls protects nothing ("Only what is wired is
 *    governed"), and neither the operator nor the project could tell an
 *    installed-but-unwired gate from a working one.
 * 2. Approval fatigue: if REVIEW decisions are answered in a couple of
 *    seconds, over and over, the operator has stopped reading and the human
 *    gate is doing theatre. A ratio like that deserves a nudge while it is
 *    still a habit, not after an incident.
 *
 * Everything here is a **local, read-only** derivation from data that already
 * exists — the gate's JSONL receipt trail and the `tool_approvals` rows the
 * approval store keeps. No network call is made, no new persisted data family
 * is opened, and no individual value (tool name, input, receipt id) is
 * printed: the check reports aggregates only. The check is advisory, in the
 * same sense as Egress (#3006): it reports state and never fails the doctor
 * verdict, because a quiet week is information, not a broken install.
 */

const fs = require('node:fs');

const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

/** The rolling window every figure below is computed over. */
const USAGE_WINDOW_DAYS = 7;
const USAGE_WINDOW_MS = USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/**
 * An approval decided faster than this is very unlikely to have been read.
 * Two seconds is generous for reading a proposal with its risk findings, and
 * deliberately so: the signal must catch skim-approving, not slow readers.
 */
const RAPID_APPROVAL_MS = 2000;
/** Fatigue is a pattern, not one fast click: warn on a ratio, with a floor. */
const RAPID_APPROVAL_RATIO_WARN = 0.5;
const MIN_DECIDED_FOR_RATIO_WARN = 5;

/** Same bounded-tail discipline as the trail's own readers (#2192 family). */
const RECEIPT_TAIL_BYTES = 4 * 1024 * 1024;

function parseIsoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readGateReceipts(receiptPath) {
  let fd;
  try {
    fd = fs.openSync(receiptPath, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { receipts: [], trailExists: false };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - RECEIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, RECEIPT_TAIL_BYTES));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    return {
      receipts: lines.filter((line) => line.trim()).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean),
      trailExists: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function receiptProfile(receipt) {
  // The gate's install profile is not stamped per event; the honest per-event
  // field is what the host said about itself (metadata.host.agentType, e.g.
  // "codex"), falling back to the agent name. Labeled "host-reported" in the
  // detail so an auditor never reads it as a verified identity.
  const host = receipt?.metadata?.host || {};
  const byHost = typeof host.agentType === 'string' && host.agentType.trim()
    ? host.agentType.trim() : '';
  const byName = typeof receipt?.metadata?.agentName === 'string' && receipt.metadata.agentName.trim()
    ? receipt.metadata.agentName.trim() : '';
  return byHost || byName || 'unknown';
}

/** Admission receipt kinds — the only receipts that count as gate events. */
const ADMISSION_KINDS = new Set([
  'external_action_admission_receipt',
  'external_action_review_receipt',
  'external_action_rejection_receipt',
]);

function summarizeGateEvents({ receipts, now }) {
  const cutoff = now - USAGE_WINDOW_MS;
  const byDecision = { allow: 0, review: 0, blocked: 0 };
  const byProfile = new Map();
  let total = 0;
  for (const receipt of receipts || []) {
    if (!receipt || !ADMISSION_KINDS.has(receipt.receiptKind)) continue;
    const at = parseIsoMs(receipt.createdAt);
    if (at === null || at < cutoff || at > now) continue;
    total += 1;
    const decision = receipt.decision === 'allow' || receipt.decision === 'review' || receipt.decision === 'blocked'
      ? receipt.decision : null;
    if (decision) byDecision[decision] += 1;
    const profile = receiptProfile(receipt);
    byProfile.set(profile, (byProfile.get(profile) || 0) + 1);
  }
  return {
    total,
    byDecision,
    byProfile: Object.fromEntries([...byProfile.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function summarizeApprovals({ rows, now }) {
  const cutoff = now - USAGE_WINDOW_MS;
  const latencies = [];
  let pending = 0;
  for (const row of rows || []) {
    const createdAt = Number(row?.created_at);
    if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > now) continue;
    const decidedAt = Number(row?.decided_at);
    if (!Number.isFinite(decidedAt) || decidedAt <= 0) {
      pending += 1;
      continue;
    }
    const latency = decidedAt - createdAt;
    if (latency >= 0) latencies.push(latency);
  }
  latencies.sort((a, b) => a - b);
  const decided = latencies.length;
  const rapid = latencies.filter((ms) => ms < RAPID_APPROVAL_MS).length;
  return {
    decided,
    pending,
    rapid,
    rapidRatio: decided > 0 ? rapid / decided : 0,
    medianLatencyMs: decided > 0 ? latencies[Math.floor(decided / 2)] : null,
    maxLatencyMs: decided > 0 ? latencies[decided - 1] : null,
  };
}

/**
 * The `Usage` doctor check. Advisory: `ok` stays true unless a local store
 * cannot be read at all — a quiet gate is information, not a defect.
 *
 * @param {object} opts { rootDir?, environment?, now?, receiptPath? }
 * @param {object} [deps] injected readers for tests:
 *   { readReceipts(path) -> {receipts, trailExists}, readApprovals() -> rows }
 */
function checkUsage(opts = {}, deps = {}) {
  const environment = opts.environment || process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const warnings = [];
  // Both sources resolve to the same shape ({receipts, trailExists}): the
  // real local read, or a test-injected reader, so the warnings below behave
  // identically whichever way the data arrived.
  const trail = typeof deps.readReceipts === 'function'
    ? (deps.readReceipts() || { receipts: [], trailExists: true })
    : readGateReceipts(opts.receiptPath || defaultExternalActionReceiptPath(environment));
  const gate = summarizeGateEvents({ receipts: trail.receipts, now });
  if (!trail.trailExists) {
    warnings.push('No gate receipt trail found: the gate is installed but no agent has called it yet. Only what is wired is governed.');
  } else if (gate.total === 0) {
    warnings.push(`The gate trail exists but no gate event was recorded in the last ${USAGE_WINDOW_DAYS} days: an installed gate no agent calls protects nothing.`);
  }

  // The doctor always injects the approval reader (it owns the store handle),
  // so a stand-alone call without one honestly reports "not read" instead of
  // reaching into the doctor's modules — that edge would be a new
  // Core->Adapters layer violation (#4135 review).
  const approvals = typeof deps.readApprovals === 'function'
    ? summarizeApprovals({ rows: deps.readApprovals() || [], now })
    : null;

  if (
    approvals !== null
    && approvals.decided >= MIN_DECIDED_FOR_RATIO_WARN
    && approvals.rapidRatio > RAPID_APPROVAL_RATIO_WARN
  ) {
    warnings.push(`Approval fatigue signal: ${approvals.rapid}/${approvals.decided} approvals in the last ${USAGE_WINDOW_DAYS} days were decided in under ${RAPID_APPROVAL_MS}ms. If they were not actually read, the REVIEW gate is doing theatre. Consider the policy templates (#4102) and allowlisting repeated safe commands, so a REVIEW left in the queue is one worth reading.`);
  }

  const parts = [];
  parts.push(`${gate.total} gate events in ${USAGE_WINDOW_DAYS}d (allow ${gate.byDecision.allow} / review ${gate.byDecision.review} / blocked ${gate.byDecision.blocked})`);
  const profileText = Object.entries(gate.byProfile).map(([profile, count]) => `${profile}: ${count}`).join(', ');
  if (profileText) parts.push(`by host-reported agent identity: ${profileText}`);
  if (approvals === null) {
    parts.push('approvals: not read (no store reader provided)');
  } else {
    parts.push(`approvals decided ${approvals.decided}, pending ${approvals.pending}`);
    if (approvals.medianLatencyMs !== null) {
      parts.push(`median decision latency ${(approvals.medianLatencyMs / 1000).toFixed(1)}s, max ${(approvals.maxLatencyMs / 1000).toFixed(1)}s`);
    }
    if (approvals.decided > 0) {
      parts.push(`rapid (<${(RAPID_APPROVAL_MS / 1000).toFixed(0)}s) approvals ${(approvals.rapidRatio * 100).toFixed(0)}%`);
    }
  }

  return {
    ok: true,
    detail: parts.join('; '),
    warnings,
    usage: {
      windowDays: USAGE_WINDOW_DAYS,
      gate,
      approvals,
      thresholds: {
        rapidApprovalMs: RAPID_APPROVAL_MS,
        rapidApprovalRatioWarn: RAPID_APPROVAL_RATIO_WARN,
        minDecidedForRatioWarn: MIN_DECIDED_FOR_RATIO_WARN,
      },
    },
  };
}

/**
 * Reads the approval rows for the usage window from the local storage store
 * (the same file the other doctor checks open). Kept behind a function so the
 * check itself stays testable without a SQLite backend: `checkUsage` normally
 * receives its rows through injected deps, and this default is only used when
 * the check runs stand-alone.
 */
function defaultApprovalRows(opts = {}) {
  // Loaded lazily and directly (not via cli-doctor, which does not export its
  // own opener): the same storage store the other checks open (#3703), read
  // only. A missing store is a true "no approval rows" answer; an unreadable
  // one is thrown so the check can fail loudly rather than report a zero.
  const { loadSqliteDriver } = require('./sqlite-availability');
  const { resolvePersistencePaths } = require('../persistencePaths');
  const { Database } = loadSqliteDriver();
  if (!Database) return [];
  const { memoryPath } = resolvePersistencePaths({ rootDir: opts.rootDir || process.cwd() });
  const dbPath = memoryPath.replace(/\.json$/i, '.db');
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare('SELECT created_at, decided_at, status, decision FROM tool_approvals').all();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  } finally {
    if (db) db.close();
  }
}

module.exports = {
  USAGE_WINDOW_DAYS,
  USAGE_WINDOW_MS,
  RAPID_APPROVAL_MS,
  RAPID_APPROVAL_RATIO_WARN,
  MIN_DECIDED_FOR_RATIO_WARN,
  readGateReceipts,
  parseIsoMs,
  receiptProfile,
  summarizeGateEvents,
  summarizeApprovals,
  checkUsage,
  defaultApprovalRows,
};