'use strict';

/**
 * #1891 — durable record of sandbox escape attempts.
 *
 * `lib/sandbox-isolation.js` (AB6) decides whether a sandboxed execution may
 * proceed, and `sandboxRunner.js` returns that verdict on `meta.ab6`. Until
 * now nothing read it: the single production caller
 * (`lib/self-healer/source-dogfood-simulator.js`) takes `result.data` and drops
 * `meta`, so a SANDBOX_VIOLATION_QUARANTINE has never been written anywhere.
 * A verdict that exists only in a returned object for the length of one call
 * cannot support a claim about anything.
 *
 * This module is the missing write. It is deliberately only the write.
 *
 * ## What this does NOT claim
 *
 * #1891's acceptance asks for escape attempts to feed a *cross-session risk
 * signal*. That is not what this is, and `lib/trust-score-aggregator.js` is
 * deliberately left untouched. The reason is measured rather than assumed:
 * `runSandboxed` has exactly one production caller, inside a subsystem that
 * `lib/module-reachability.js` records as "library-only by product decision; no
 * autonomous runner". Scoring a stream that nothing feeds would put "sandbox
 * escape monitoring" on a trust score whose deduction is always zero — a clean
 * number asserting a coverage that does not exist. An empty ledger is honest;
 * a confident score over an empty ledger is not.
 *
 * So: the recording path is real and reachable now, and when a caller that
 * actually executes untrusted code arrives, the evidence is already
 * accumulating and the aggregator half becomes a small, obvious follow-up.
 *
 * ## Escapes only
 *
 * An `allow` verdict is not recorded. Every sandboxed call producing a row
 * would make the trail a volume metric that a reader has to filter before it
 * means anything, and the question this exists to answer is "did anything try
 * to get out", not "how often did we run a sandbox".
 *
 * ## Recording never breaks execution
 *
 * Every failure path returns null. Observation must not become a new way for a
 * sandbox call to fail, which is the same stance `lib/llm-proxy/proxy-handler.js`
 * takes for its own receipts.
 */

const crypto = require('node:crypto');

const { createTrustEvidenceLedger } = require('./trust-evidence-ledger');

const SANDBOX_ESCAPE_OPERATION_PREFIX = 'sandbox-isolation:';
const SANDBOX_ESCAPE_POLICY_VERSION = 'huqan.sandbox-escape-ledger.v1';

/**
 * AB6's non-allow verdicts. `quarantine` is included deliberately: it means
 * "may proceed, but only isolated", which is the runner recording that it did
 * not trust what it was given. That is exactly the attempt worth keeping.
 */
const ESCAPE_DECISIONS = Object.freeze(new Set(['block', 'quarantine']));

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/** @returns {boolean} whether this AB6 verdict is worth a durable row. */
function isEscapeVerdict(verdict) {
  return Boolean(verdict) && typeof verdict === 'object'
    && ESCAPE_DECISIONS.has(text(verdict.decision));
}

/**
 * Appends one escape attempt to the trust evidence ledger.
 *
 * @param {object} input
 * @param {object} input.graph a graph exposing `runMutationOnce`
 * @param {object} input.verdict AB6's `{ decision, reason }`
 * @param {string} [input.workspaceId]
 * @param {string} [input.sourceRef] who was running the sandbox
 * @returns {object|null} the ledger receipt, or null when nothing was recorded
 */
function recordSandboxVerdict({ graph, verdict, workspaceId, sourceRef } = {}) {
  if (!graph || !isEscapeVerdict(verdict)) return null;

  try {
    const ledger = createTrustEvidenceLedger({ graph });
    const decision = text(verdict.decision);
    const reason = text(verdict.reason) || 'sandbox_verdict_reason_absent';
    const workspace = text(workspaceId) || 'default';
    return ledger.append({
      operationId: `${SANDBOX_ESCAPE_OPERATION_PREFIX}${crypto.randomUUID()}`,
      event: {
        workspaceId: workspace,
        decision,
        reason,
        actionFingerprint: crypto.createHash('sha256').update(`${decision}:${reason}`).digest('hex').slice(0, 32),
        createdAt: new Date().toISOString(),
        policyVersion: SANDBOX_ESCAPE_POLICY_VERSION,
        connectorRef: 'sandbox-runner',
        resourceRef: text(sourceRef) || 'sandbox:unattributed',
        executionOutcome: `sandbox_${decision}`,
      },
      // The workspace is repeated in the mutation result, not only in the
      // receipt event: the prefix read below returns committed results, so a
      // field a reader needs has to live there or it is not readable back.
      mutate: () => ({ sandboxEscape: true, decision, reason, workspaceId: workspace }),
    });
  } catch (_) {
    // Deliberately swallowed: see the module note. A caller must never learn
    // that the evidence store failed by having its sandbox call throw.
    return null;
  }
}

/**
 * Reads back every recorded escape attempt.
 *
 * Present so the aggregator half of #1891 is a small change against a stable
 * shape rather than an excavation of the mutation journal, and so the tests
 * above can assert on what was actually persisted rather than on the fact that
 * a write was attempted.
 *
 * @returns {Array<{operationId: string, decision: string, reason: string, workspaceId: string}>}
 */
function readSandboxEscapes(graph) {
  if (!graph || typeof graph.getCommittedMutationResultsByPrefix !== 'function') return [];
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(SANDBOX_ESCAPE_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row) => row && row.result && row.result.sandboxEscape === true)
    .map((row) => Object.freeze({
      operationId: text(row.operationId),
      decision: text(row.result.decision),
      reason: text(row.result.reason),
      workspaceId: text(row.result.workspaceId) || 'default',
    }));
}

module.exports = {
  SANDBOX_ESCAPE_OPERATION_PREFIX,
  SANDBOX_ESCAPE_POLICY_VERSION,
  isEscapeVerdict,
  recordSandboxVerdict,
  readSandboxEscapes,
};
