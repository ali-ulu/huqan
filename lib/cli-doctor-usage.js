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
    // The issue asks for REVIEW / ALLOW explicitly; null says "no ALLOW yet"
    // rather than inventing an infinite or zero ratio (#4135 review).
    reviewAllowRatio: byDecision.allow > 0 ? byDecision.review / byDecision.allow : null,
    byProfile: Object.fromEntries([...byProfile.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function summarizeApprovals({ rows, now }) {
  const cutoff = now - USAGE_WINDOW_MS;
  // Latency covers every terminal decision; the fatigue signal is about
  // approvals only, because a fast rejection is the human gate working, not
  // theatre (#4135 review).
  const latencies = [];
  const approvedLatencies = [];
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
    if (latency < 0) continue;
    latencies.push(latency);
    if (row?.decision === 'approved') approvedLatencies.push(latency);
  }
  latencies.sort((a, b) => a - b);
  approvedLatencies.sort((a, b) => a - b);
  const decided = latencies.length;
  const approved = approvedLatencies.length;
  const rapid = approvedLatencies.filter((ms) => ms < RAPID_APPROVAL_MS).length;
  return {
    decided,
    approved,
    pending,
    rapid,
    rapidRatio: approved > 0 ? rapid / approved : 0,
    medianLatencyMs: decided > 0 ? latencies[Math.floor(decided / 2)] : null,
    maxLatencyMs: decided > 0 ? latencies[decided - 1] : null,
  };
}

/**
 * The `Usage` doctor check. Advisory: `ok` always stays true — a quiet gate is
 * information, and an unreadable local store is reported as a warning, never as
 * a failed verdict, because doctor already has dedicated checks for the
 * stores themselves.
 *
 * @param {object} opts { rootDir?, environment?, now?, receiptPath? }
 * @param {object} [deps] injected readers for tests:
 *   { readReceipts(path) -> {receipts, trailExists}, readApprovals() -> rows,
 *     readInstalledProfiles() -> profile names }
 */
function checkUsage(opts = {}, deps = {}) {
  const environment = opts.environment || process.env;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const warnings = [];
  // Both sources resolve to the same shape ({receipts, trailExists}): the
  // real local read, or a test-injected reader, so the warnings below behave
  // identically whichever way the data arrived. A reader failure is a warning,
  // never a throw: the check is advisory (#4135 review).
  let trail;
  try {
    trail = typeof deps.readReceipts === 'function'
      ? (deps.readReceipts() || { receipts: [], trailExists: true })
      : readGateReceipts(opts.receiptPath || defaultExternalActionReceiptPath(environment));
  } catch (error) {
    warnings.push(`Gate receipt trail could not be read (${error?.code || 'error'}); gate figures are not measurable.`);
    trail = { receipts: [], trailExists: true, unreadable: true };
  }
  const gate = summarizeGateEvents({ receipts: trail.receipts, now });
  if (trail.unreadable) {
    // already warned above
  } else if (!trail.trailExists) {
    warnings.push('No gate receipt trail found: the gate is installed but no agent has called it yet. Only what is wired is governed.');
  } else if (gate.total === 0) {
    warnings.push(`The gate trail exists but no gate event was recorded in the last ${USAGE_WINDOW_DAYS} days: an installed gate no agent calls protects nothing.`);
  }

  // Installed-but-silent profiles (#4135 acceptance): only the artifact-backed
  // inventory can name a profile that never appears in the trail. Custom/generic
  // agents have no artifact, so they are never part of this comparison.
  let installedProfiles = null;
  if (typeof deps.readInstalledProfiles === 'function') {
    try {
      installedProfiles = deps.readInstalledProfiles() || [];
    } catch (error) {
      warnings.push(`Installed gate profiles could not be read (${error?.code || 'error'}); the silent-profile comparison is not measurable.`);
    }
  }
  let silentProfiles = [];
  if (installedProfiles !== null && !trail.unreadable && trail.trailExists && gate.total > 0) {
    silentProfiles = installedProfiles.filter((profile) => !gate.byProfile[profile]);
    if (silentProfiles.length > 0) {
      warnings.push(`Installed gate profile(s) ${silentProfiles.join(', ')} had no gate event in the last ${USAGE_WINDOW_DAYS} days: the artifact is in place but the agent never called it. Only what is wired is governed.`);
    }
  }

  // The doctor always injects the approval reader (it owns the store handle),
  // so a stand-alone call without one honestly reports "not read" instead of
  // reaching into the doctor's modules — that edge would be a new
  // Core->Adapters layer violation (#4135 review).
  let approvals = null;
  if (typeof deps.readApprovals === 'function') {
    try {
      approvals = summarizeApprovals({ rows: deps.readApprovals() || [], now });
    } catch (error) {
      warnings.push(`Approval rows could not be read (${error?.code || 'error'}); approval figures are not measurable.`);
    }
  }

  if (
    approvals !== null
    && approvals.approved >= MIN_DECIDED_FOR_RATIO_WARN
    && approvals.rapidRatio > RAPID_APPROVAL_RATIO_WARN
  ) {
    warnings.push(`Approval fatigue signal: ${approvals.rapid}/${approvals.approved} approvals in the last ${USAGE_WINDOW_DAYS} days were decided in under ${RAPID_APPROVAL_MS}ms. If they were not actually read, the REVIEW gate is doing theatre. Consider the policy templates (#4102) and allowlisting repeated safe commands, so a REVIEW left in the queue is one worth reading.`);
  }

  const parts = [];
  const reviewAllowText = gate.reviewAllowRatio === null ? 'n/a' : gate.reviewAllowRatio.toFixed(2);
  parts.push(`${gate.total} gate events in ${USAGE_WINDOW_DAYS}d (allow ${gate.byDecision.allow} / review ${gate.byDecision.review} / blocked ${gate.byDecision.blocked}; REVIEW/ALLOW ${reviewAllowText})`);
  const profileText = Object.entries(gate.byProfile).map(([profile, count]) => `${profile}: ${count}`).join(', ');
  if (profileText) parts.push(`by host-reported agent identity: ${profileText}`);
  if (approvals === null) {
    parts.push('approvals: not read (no store reader provided)');
  } else {
    parts.push(`approvals decided ${approvals.decided}, pending ${approvals.pending}`);
    if (approvals.medianLatencyMs !== null) {
      parts.push(`median decision latency ${(approvals.medianLatencyMs / 1000).toFixed(1)}s, max ${(approvals.maxLatencyMs / 1000).toFixed(1)}s`);
    }
    if (approvals.approved > 0) {
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
      installedProfiles,
      silentProfiles,
      approvals,
      thresholds: {
        rapidApprovalMs: RAPID_APPROVAL_MS,
        rapidApprovalRatioWarn: RAPID_APPROVAL_RATIO_WARN,
        minDecidedForRatioWarn: MIN_DECIDED_FOR_RATIO_WARN,
      },
    },
  };
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
};