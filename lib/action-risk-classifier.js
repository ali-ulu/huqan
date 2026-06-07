'use strict';

/**
 * action-risk-classifier.js
 * AB1 — Action Risk Classifier
 *
 * Classifies intended agent actions before any execution layer exists.
 * Does NOT execute tools. Does NOT write memory. Does NOT deploy.
 * Only classifies risk.
 *
 * @module action-risk-classifier
 */

const POLICY_VERSION = 'AB1.0.0';

// ─── Action Types ────────────────────────────────────────────────────────────

const ACTION_TYPES = Object.freeze({
  READ_ONLY:        'read_only',
  LOCAL_ANALYSIS:   'local_analysis',
  TEST_EXECUTION:   'test_execution',
  FILE_WRITE:       'file_write',
  MEMORY_WRITE:     'memory_write',
  TOOL_EXECUTION:   'tool_execution',
  NETWORK_ACCESS:   'network_access',
  DEPLOYMENT:       'deployment',
  DESTRUCTIVE:      'destructive',
  AUTO_MERGE:       'auto_merge',
  UNKNOWN:          'unknown',
});

// ─── Risk Levels ─────────────────────────────────────────────────────────────

const RISK_LEVELS = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});

// ─── Decisions ───────────────────────────────────────────────────────────────

const DECISIONS = Object.freeze({
  ALLOW:        'allow',
  REVIEW:       'review',
  BLOCK:        'block',
  HUMAN_REVIEW: 'human_review',
});

// ─── Policy Table ─────────────────────────────────────────────────────────────
// Maps actionType → { riskLevel, decision, requiredReview }

const POLICY_TABLE = Object.freeze({
  [ACTION_TYPES.READ_ONLY]:      { riskLevel: RISK_LEVELS.LOW,      decision: DECISIONS.ALLOW,        requiredReview: false },
  [ACTION_TYPES.LOCAL_ANALYSIS]: { riskLevel: RISK_LEVELS.LOW,      decision: DECISIONS.ALLOW,        requiredReview: false },
  [ACTION_TYPES.TEST_EXECUTION]: { riskLevel: RISK_LEVELS.MEDIUM,   decision: DECISIONS.ALLOW,        requiredReview: false },
  [ACTION_TYPES.FILE_WRITE]:     { riskLevel: RISK_LEVELS.MEDIUM,   decision: DECISIONS.REVIEW,       requiredReview: true  },
  [ACTION_TYPES.MEMORY_WRITE]:   { riskLevel: RISK_LEVELS.HIGH,     decision: DECISIONS.REVIEW,       requiredReview: true  },
  [ACTION_TYPES.TOOL_EXECUTION]: { riskLevel: RISK_LEVELS.HIGH,     decision: DECISIONS.REVIEW,       requiredReview: true  },
  [ACTION_TYPES.NETWORK_ACCESS]: { riskLevel: RISK_LEVELS.HIGH,     decision: DECISIONS.REVIEW,       requiredReview: true  },
  [ACTION_TYPES.DEPLOYMENT]:     { riskLevel: RISK_LEVELS.CRITICAL, decision: DECISIONS.HUMAN_REVIEW, requiredReview: true  },
  [ACTION_TYPES.DESTRUCTIVE]:    { riskLevel: RISK_LEVELS.CRITICAL, decision: DECISIONS.BLOCK,        requiredReview: true  },
  [ACTION_TYPES.AUTO_MERGE]:     { riskLevel: RISK_LEVELS.CRITICAL, decision: DECISIONS.BLOCK,        requiredReview: true  },
  [ACTION_TYPES.UNKNOWN]:        { riskLevel: RISK_LEVELS.HIGH,     decision: DECISIONS.REVIEW,       requiredReview: true  },
});

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize an actionType input to a known ACTION_TYPES value or 'unknown'.
 * @param {*} actionType
 * @returns {string}
 */
function normalizeActionType(actionType) {
  if (actionType === null || actionType === undefined) return ACTION_TYPES.UNKNOWN;
  if (typeof actionType !== 'string') {
    // objects, numbers, arrays → unknown
    if (typeof actionType === 'object' || typeof actionType === 'number' || Array.isArray(actionType)) {
      return ACTION_TYPES.UNKNOWN;
    }
    return ACTION_TYPES.UNKNOWN;
  }
  const normalized = actionType.trim().toLowerCase().replace(/[-\s]+/g, '_');
  const knownValues = Object.values(ACTION_TYPES);
  if (knownValues.includes(normalized)) return normalized;
  return ACTION_TYPES.UNKNOWN;
}

// ─── Reason Builders ─────────────────────────────────────────────────────────

function buildReasons(actionType, policy, opts) {
  const reasons = [];

  switch (policy.riskLevel) {
    case RISK_LEVELS.LOW:
      reasons.push(`Action type '${actionType}' is low-risk and does not modify state.`);
      break;
    case RISK_LEVELS.MEDIUM:
      reasons.push(`Action type '${actionType}' may modify local state and requires caution.`);
      break;
    case RISK_LEVELS.HIGH:
      reasons.push(`Action type '${actionType}' has high potential for side effects.`);
      break;
    case RISK_LEVELS.CRITICAL:
      reasons.push(`Action type '${actionType}' is critical and cannot proceed without explicit approval.`);
      break;
  }

  if (actionType === ACTION_TYPES.UNKNOWN) {
    reasons.push('Unknown action type is never silently allowed.');
  }
  if (actionType === ACTION_TYPES.AUTO_MERGE) {
    reasons.push('Auto-merge is permanently blocked by policy AB1.');
  }
  if (actionType === ACTION_TYPES.DESTRUCTIVE) {
    reasons.push('Destructive actions are permanently blocked by policy AB1.');
  }
  if (actionType === ACTION_TYPES.DEPLOYMENT) {
    reasons.push('Deployment requires human review before execution.');
  }

  if (opts && opts.reason) {
    reasons.push(String(opts.reason));
  }

  return reasons;
}

// ─── Main Classifier ─────────────────────────────────────────────────────────

/**
 * Classify an intended agent action.
 *
 * @param {*} action - The action to classify. Can be:
 *   - a string: treated as actionType directly
 *   - an object: { actionType, reason?, meta? }
 *   - null / undefined / anything else: treated as unknown
 * @param {object} [opts={}] - Options
 * @param {string} [opts.reason] - Optional reason string for audit
 * @param {object} [opts.meta] - Optional extra metadata
 * @returns {{
 *   ok: boolean,
 *   actionType: string,
 *   riskLevel: string,
 *   decision: string,
 *   reasons: string[],
 *   requiredReview: boolean,
 *   blocked: boolean,
 *   policyVersion: string,
 *   meta: object
 * }}
 */
function classify(action, opts = {}) {
  // Normalize opts safely
  const safeOpts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};

  // Extract actionType from input
  let rawActionType;
  if (action === null || action === undefined) {
    rawActionType = ACTION_TYPES.UNKNOWN;
  } else if (typeof action === 'string') {
    rawActionType = action;
  } else if (typeof action === 'object' && !Array.isArray(action)) {
    rawActionType = action.actionType || action.type || ACTION_TYPES.UNKNOWN;
    // Merge action-level meta into opts
    if (action.meta && typeof action.meta === 'object') {
      safeOpts.meta = { ...(safeOpts.meta || {}), ...action.meta };
    }
    if (action.reason && !safeOpts.reason) {
      safeOpts.reason = action.reason;
    }
  } else {
    rawActionType = ACTION_TYPES.UNKNOWN;
  }

  const actionType = normalizeActionType(rawActionType);
  const policy = POLICY_TABLE[actionType];

  const blocked = policy.decision === DECISIONS.BLOCK || policy.decision === DECISIONS.HUMAN_REVIEW;
  const reasons = buildReasons(actionType, policy, safeOpts);

  return {
    ok: true,
    actionType,
    riskLevel: policy.riskLevel,
    decision: policy.decision,
    reasons,
    requiredReview: policy.requiredReview,
    blocked,
    policyVersion: POLICY_VERSION,
    meta: {
      ...(safeOpts.meta && typeof safeOpts.meta === 'object' ? safeOpts.meta : {}),
    },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classify,
  normalizeActionType,
  ACTION_TYPES,
  RISK_LEVELS,
  DECISIONS,
  POLICY_VERSION,
};
