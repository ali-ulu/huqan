'use strict';

/**
 * Self-Healer safety decision engine.
 *
 * `docs/self-healer-safety-matrix.md` defines five decision levels and a rule
 * matrix, but until now existed only as prose -- nothing in source mapped a
 * finding onto a decision. This module is that mapping, and it is the only
 * place the matrix is encoded.
 *
 * The governing principle from the doc is `AXIOM judges, human decides.`
 * Every decision this module can return is either "record it", "ask a human",
 * or "refuse". None of them authorizes applying anything, which is why there
 * is no `apply` or `auto_fix` decision level.
 *
 * Default is fail-closed: a finding this module cannot confidently place lands
 * on `require_review`, never on `propose`.
 */

const SELF_HEALER_DECISIONS = Object.freeze({
  OBSERVE: 'observe',
  PROPOSE: 'propose',
  REQUIRE_REVIEW: 'require_review',
  BLOCK: 'block',
  QUARANTINE: 'quarantine',
});

const SELF_HEALER_DECISION_REASONS = Object.freeze({
  DESTRUCTIVE_ACTION_BLOCKED: 'destructive_action_blocked',
  UNKNOWN_TOOL_BLOCKED: 'unknown_tool_blocked',
  RELEASE_OPERATION_BLOCKED: 'release_operation_blocked',
  CODE_CHANGE_GATE_BLOCKED: 'code_change_gate_blocked',
  INSUFFICIENT_EVIDENCE_QUARANTINED: 'insufficient_evidence_quarantined',
  BEHAVIORAL_DEVIATION_QUARANTINED: 'behavioral_deviation_quarantined',
  BEHAVIORAL_DEVIATION_REVIEW: 'behavioral_deviation_requires_review',
  NO_EVIDENCE_OBSERVE_ONLY: 'no_evidence_observe_only',
  NO_AFFECTED_SURFACE_OBSERVE_ONLY: 'no_affected_surface_observe_only',
  MEMORY_MUTATION_REVIEW: 'memory_mutation_requires_review',
  CANONICAL_WRITE_REVIEW: 'canonical_write_requires_review',
  RUNTIME_MUTATION_REVIEW: 'runtime_mutation_requires_review',
  CROSS_WORKSPACE_REVIEW: 'cross_workspace_risk_requires_review',
  DEPENDENCY_SETUP_REVIEW: 'dependency_setup_requires_review',
  DOCS_ONLY_PROPOSAL: 'docs_only_proposal',
  DEFAULT_REVIEW_REQUIRED: 'default_review_required',
});

/**
 * Risk flags that end the evaluation immediately. Ordered: the matrix rows for
 * destructive cleanup, unknown tool, and release/tag/deploy are all `block`,
 * and a blocked finding is never downgraded by anything later.
 */
const BLOCKING_RISK_FLAGS = Object.freeze([
  { flag: 'destructive_action', reason: SELF_HEALER_DECISION_REASONS.DESTRUCTIVE_ACTION_BLOCKED },
  { flag: 'unknown_tool', reason: SELF_HEALER_DECISION_REASONS.UNKNOWN_TOOL_BLOCKED },
  { flag: 'release_operation', reason: SELF_HEALER_DECISION_REASONS.RELEASE_OPERATION_BLOCKED },
  { flag: 'code_change_gate_block', reason: SELF_HEALER_DECISION_REASONS.CODE_CHANGE_GATE_BLOCKED },
]);

/**
 * Risk flags that force human review. These correspond to the matrix rows for
 * production memory write, canonical graph write, and runtime code patch.
 * `cross_workspace_risk` and `dependency_setup` have no matrix row of their
 * own; they are listed in the doc's risk-flag set, so they are mapped to the
 * strictest non-blocking level rather than being silently ignored.
 */
const QUARANTINE_RISK_FLAGS = Object.freeze([
  { flag: 'behavioral_quarantine', reason: SELF_HEALER_DECISION_REASONS.BEHAVIORAL_DEVIATION_QUARANTINED },
]);

const REVIEW_RISK_FLAGS = Object.freeze([
  { flag: 'behavioral_deviation', reason: SELF_HEALER_DECISION_REASONS.BEHAVIORAL_DEVIATION_REVIEW },
  { flag: 'memory_mutation', reason: SELF_HEALER_DECISION_REASONS.MEMORY_MUTATION_REVIEW },
  { flag: 'canonical_write', reason: SELF_HEALER_DECISION_REASONS.CANONICAL_WRITE_REVIEW },
  { flag: 'runtime_mutation', reason: SELF_HEALER_DECISION_REASONS.RUNTIME_MUTATION_REVIEW },
  { flag: 'cross_workspace_risk', reason: SELF_HEALER_DECISION_REASONS.CROSS_WORKSPACE_REVIEW },
  { flag: 'dependency_setup', reason: SELF_HEALER_DECISION_REASONS.DEPENDENCY_SETUP_REVIEW },
]);

const ALLOWED_NEXT_STEPS = Object.freeze({
  observe: Object.freeze(['record']),
  propose: Object.freeze(['human_review', 'manual_apply']),
  require_review: Object.freeze(['human_review']),
  block: Object.freeze([]),
  quarantine: Object.freeze(['isolate', 'human_review']),
});

const DOCS_PATH_PATTERN = /(^|\/)(docs?)\//i;
const DOCS_FILE_PATTERN = /\.(md|mdx|markdown|txt|rst)$/i;

const { isPlainObject } = require('../is-plain-object');

function normalizeFlagList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean);
}

function normalizeFileList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value ?? '').trim()).filter(Boolean);
}

/**
 * A finding is docs-only when it names at least one affected file and every
 * one of them is documentation. An empty file list is deliberately not
 * docs-only: "we changed nothing anywhere" must not earn the most permissive
 * decision level.
 */
function isDocsOnly(affectedFiles) {
  if (affectedFiles.length === 0) return false;
  return affectedFiles.every((file) => DOCS_PATH_PATTERN.test(file) || DOCS_FILE_PATTERN.test(file));
}

function hasObservableEvidence(finding) {
  return Array.isArray(finding.evidence) && finding.evidence.length > 0;
}

/**
 * Maps one finding onto a safety-matrix decision.
 *
 * Evaluation order is deliberate and is itself the safety property:
 *   1. blocking risk flags   -- a block is never downgraded
 *   2. explicit distrust     -- quarantine before anything is proposed
 *   3. minimum evidence rule -- cannot propose a fix without evidence
 *   4. review risk flags     -- mutation-bearing findings need a human
 *   5. docs-only             -- the single path to `propose`
 *   6. default               -- require_review (fail-closed)
 *
 * @param {object} finding a normalized finding (see finding-schema.js)
 * @returns {{decision: string, reason: string, requiresApproval: boolean, allowedNextSteps: string[], riskFlags: string[]}}
 */
function decideSelfHealerAction(finding) {
  if (!isPlainObject(finding)) {
    throw new TypeError('finding must be an object');
  }

  const riskFlags = normalizeFlagList(finding.riskFlags);
  const affectedFiles = normalizeFileList(finding.affectedFiles);

  for (const { flag, reason } of BLOCKING_RISK_FLAGS) {
    if (riskFlags.includes(flag)) {
      return buildDecision(SELF_HEALER_DECISIONS.BLOCK, reason, riskFlags);
    }
  }

  for (const { flag, reason } of QUARANTINE_RISK_FLAGS) {
    if (riskFlags.includes(flag)) {
      return buildDecision(SELF_HEALER_DECISIONS.QUARANTINE, reason, riskFlags);
    }
  }

  if (riskFlags.includes('insufficient_evidence')) {
    return buildDecision(
      SELF_HEALER_DECISIONS.QUARANTINE,
      SELF_HEALER_DECISION_REASONS.INSUFFICIENT_EVIDENCE_QUARANTINED,
      riskFlags,
    );
  }

  // Behavioral findings describe a runtime agent surface, not a source file.
  // Evaluate this flag before the no-affected-files observe fallback so an
  // out-of-baseline action cannot be silently downgraded to observation.
  if (riskFlags.includes('behavioral_deviation')) {
    return buildDecision(
      SELF_HEALER_DECISIONS.REQUIRE_REVIEW,
      SELF_HEALER_DECISION_REASONS.BEHAVIORAL_DEVIATION_REVIEW,
      riskFlags,
    );
  }

  if (!hasObservableEvidence(finding)) {
    return buildDecision(
      SELF_HEALER_DECISIONS.OBSERVE,
      SELF_HEALER_DECISION_REASONS.NO_EVIDENCE_OBSERVE_ONLY,
      riskFlags,
    );
  }

  if (affectedFiles.length === 0) {
    return buildDecision(
      SELF_HEALER_DECISIONS.OBSERVE,
      SELF_HEALER_DECISION_REASONS.NO_AFFECTED_SURFACE_OBSERVE_ONLY,
      riskFlags,
    );
  }

  for (const { flag, reason } of REVIEW_RISK_FLAGS) {
    if (riskFlags.includes(flag)) {
      return buildDecision(SELF_HEALER_DECISIONS.REQUIRE_REVIEW, reason, riskFlags);
    }
  }

  if (finding.kind === 'stale_docs' && isDocsOnly(affectedFiles)) {
    return buildDecision(
      SELF_HEALER_DECISIONS.PROPOSE,
      SELF_HEALER_DECISION_REASONS.DOCS_ONLY_PROPOSAL,
      riskFlags,
    );
  }

  return buildDecision(
    SELF_HEALER_DECISIONS.REQUIRE_REVIEW,
    SELF_HEALER_DECISION_REASONS.DEFAULT_REVIEW_REQUIRED,
    riskFlags,
  );
}

function buildDecision(decision, reason, riskFlags) {
  return {
    decision,
    reason,
    requiresApproval: decision !== SELF_HEALER_DECISIONS.OBSERVE
      && decision !== SELF_HEALER_DECISIONS.BLOCK,
    allowedNextSteps: [...ALLOWED_NEXT_STEPS[decision]],
    riskFlags: [...riskFlags],
  };
}

module.exports = {
  SELF_HEALER_DECISIONS,
  SELF_HEALER_DECISION_REASONS,
  ALLOWED_NEXT_STEPS,
  decideSelfHealerAction,
  isDocsOnly,
};
