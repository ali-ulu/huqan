'use strict';

const ACTION_CATEGORIES = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  MEMORY_WRITE: 'MEMORY_WRITE',
  CANONICAL_GRAPH_WRITE: 'CANONICAL_GRAPH_WRITE',
  CODE_CHANGE: 'CODE_CHANGE',
  TEST_CHANGE: 'TEST_CHANGE',
  SECURITY_POLICY_CHANGE: 'SECURITY_POLICY_CHANGE',
  DEPLOYMENT: 'DEPLOYMENT',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  FILESYSTEM_WRITE: 'FILESYSTEM_WRITE',
  NETWORK_CALL: 'NETWORK_CALL',
  TOOL_CHAIN_EXECUTION: 'TOOL_CHAIN_EXECUTION',
  SANDBOX_SIMULATION: 'SANDBOX_SIMULATION',
  PRODUCTION_MUTATION: 'PRODUCTION_MUTATION',
});

const ACTION_DECISIONS = Object.freeze({
  ALLOW: 'ALLOW',
  BLOCK: 'BLOCK',
  QUARANTINE: 'QUARANTINE',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
});

const RISK_LEVELS = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

const FLAGS = Object.freeze({
  AUTO_MERGE: 'AUTO_MERGE',
  AUTO_DEPLOY: 'AUTO_DEPLOY',
  SELF_ESCALATION: 'SELF_ESCALATION',
  HARD_BLOCKED: 'HARD_BLOCKED',
  MALFORMED_ACTION: 'MALFORMED_ACTION',
  UNKNOWN_ACTION_CATEGORY: 'UNKNOWN_ACTION_CATEGORY',
  PATH_SECURITY_SENSITIVE: 'PATH_SECURITY_SENSITIVE',
  PATH_OUTSIDE_ALLOWLIST: 'PATH_OUTSIDE_ALLOWLIST',
  URL_OUTSIDE_ALLOWLIST: 'URL_OUTSIDE_ALLOWLIST',
  PRODUCTION_SIDE: 'PRODUCTION_SIDE',
  BYPASS_ADMISSION: 'BYPASS_ADMISSION',
  REAL_DB: 'REAL_DB',
  UNGATED_TOOL_CHAIN: 'UNGATED_TOOL_CHAIN',
  EXPLICIT_HUMAN_APPROVAL: 'EXPLICIT_HUMAN_APPROVAL',
});

const SECURITY_SENSITIVE_PATH_TOKENS = Object.freeze([
  'requestGuards.js',
  'server.js',
  'toolPolicy.js',
  'lib/trust-policy.js',
  'lib/risk-rules.js',
  'lib/action-risk-classifier.js',
  'lib/verify.js',
  'kernel.js',
  'kernel.v2.js',
  'package.json',
]);

const HIGH_IMPACT_WRITE_CATEGORIES = new Set([
  ACTION_CATEGORIES.MEMORY_WRITE,
  ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE,
  ACTION_CATEGORIES.CODE_CHANGE,
  ACTION_CATEGORIES.TEST_CHANGE,
  ACTION_CATEGORIES.SECURITY_POLICY_CHANGE,
  ACTION_CATEGORIES.DEPLOYMENT,
  ACTION_CATEGORIES.PERMISSION_CHANGE,
  ACTION_CATEGORIES.PRODUCTION_MUTATION,
]);
Object.freeze(HIGH_IMPACT_WRITE_CATEGORIES);

const POLICY_VERSION = 'AB1-v2.0.0';

const CATEGORY_ALIASES = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  READONLY: 'READ_ONLY',
  READ: 'READ_ONLY',
  LOCAL_ANALYSIS: 'READ_ONLY',
  ASK: 'READ_ONLY',
  VERIFY: 'READ_ONLY',
  REASON: 'READ_ONLY',
  COMPARE: 'READ_ONLY',
  DREAM: 'READ_ONLY',

  MEMORY_WRITE: 'MEMORY_WRITE',
  MEMORY_STORE: 'MEMORY_WRITE',
  MEMORY_PATCH: 'MEMORY_WRITE',
  MEMORY_LINK: 'MEMORY_WRITE',

  CANONICAL_GRAPH_WRITE: 'CANONICAL_GRAPH_WRITE',
  GRAPH_WRITE: 'CANONICAL_GRAPH_WRITE',
  CLAIM_WRITE: 'CANONICAL_GRAPH_WRITE',
  EDGE_WRITE: 'CANONICAL_GRAPH_WRITE',
  SUPERSEDE: 'CANONICAL_GRAPH_WRITE',
  TOMBSTONE: 'CANONICAL_GRAPH_WRITE',

  CODE_CHANGE: 'CODE_CHANGE',
  CODE_WRITE: 'CODE_CHANGE',
  PATCH: 'CODE_CHANGE',
  COMMIT: 'CODE_CHANGE',
  AUTO_MERGE: 'CODE_CHANGE',
  MERGE: 'CODE_CHANGE',

  TEST_CHANGE: 'TEST_CHANGE',
  TEST_WRITE: 'TEST_CHANGE',
  TEST_EXECUTION: 'SANDBOX_SIMULATION',

  SECURITY_POLICY_CHANGE: 'SECURITY_POLICY_CHANGE',
  TRUST_POLICY_CHANGE: 'SECURITY_POLICY_CHANGE',
  RISK_RULES_CHANGE: 'SECURITY_POLICY_CHANGE',
  SECURITY_GATE_CHANGE: 'SECURITY_POLICY_CHANGE',

  DEPLOYMENT: 'DEPLOYMENT',
  DEPLOY: 'DEPLOYMENT',
  RELEASE: 'DEPLOYMENT',
  ROLLOUT: 'DEPLOYMENT',

  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  PERMISSION: 'PERMISSION_CHANGE',
  SCOPE_EXPANSION: 'PERMISSION_CHANGE',
  ESCALATE: 'PERMISSION_CHANGE',
  SELF_ESCALATION: 'PERMISSION_CHANGE',

  FILESYSTEM_WRITE: 'FILESYSTEM_WRITE',
  FILE_WRITE: 'FILESYSTEM_WRITE',
  FS_WRITE: 'FILESYSTEM_WRITE',
  WRITE_FILE: 'FILESYSTEM_WRITE',
  FILE_WRITE_OP: 'FILESYSTEM_WRITE',

  NETWORK_CALL: 'NETWORK_CALL',
  NETWORK_ACCESS: 'NETWORK_CALL',
  HTTP_REQUEST: 'NETWORK_CALL',
  FETCH: 'NETWORK_CALL',
  WEBHOOK: 'NETWORK_CALL',
  DNS_LOOKUP: 'NETWORK_CALL',
  SMTP_SEND: 'NETWORK_CALL',

  TOOL_CHAIN_EXECUTION: 'TOOL_CHAIN_EXECUTION',
  TOOL_EXECUTION: 'TOOL_CHAIN_EXECUTION',
  TOOL_CHAIN: 'TOOL_CHAIN_EXECUTION',
  WORKFLOW: 'TOOL_CHAIN_EXECUTION',
  CHAIN: 'TOOL_CHAIN_EXECUTION',
  PLAN_AND_EXECUTE: 'TOOL_CHAIN_EXECUTION',

  SANDBOX_SIMULATION: 'SANDBOX_SIMULATION',
  SANDBOX: 'SANDBOX_SIMULATION',
  VM: 'SANDBOX_SIMULATION',
  EVAL_SANDBOX: 'SANDBOX_SIMULATION',
  ISOLATED_WORKER: 'SANDBOX_SIMULATION',

  PRODUCTION_MUTATION: 'PRODUCTION_MUTATION',
  PRODUCTION_WRITE: 'PRODUCTION_MUTATION',
  PROD_WRITE: 'PRODUCTION_MUTATION',
  DESCRIPTIVE: 'PRODUCTION_MUTATION',
  DESTRUCTIVE: 'PRODUCTION_MUTATION',
  DESCTRUCTIVE: 'PRODUCTION_MUTATION',
});

const RISK_BY_CATEGORY = Object.freeze({
  READ_ONLY: RISK_LEVELS.LOW,
  MEMORY_WRITE: RISK_LEVELS.HIGH,
  CANONICAL_GRAPH_WRITE: RISK_LEVELS.HIGH,
  CODE_CHANGE: RISK_LEVELS.HIGH,
  TEST_CHANGE: RISK_LEVELS.HIGH,
  SECURITY_POLICY_CHANGE: RISK_LEVELS.CRITICAL,
  DEPLOYMENT: RISK_LEVELS.CRITICAL,
  PERMISSION_CHANGE: RISK_LEVELS.CRITICAL,
  FILESYSTEM_WRITE: RISK_LEVELS.MEDIUM,
  NETWORK_CALL: RISK_LEVELS.MEDIUM,
  TOOL_CHAIN_EXECUTION: RISK_LEVELS.HIGH,
  SANDBOX_SIMULATION: RISK_LEVELS.MEDIUM,
  PRODUCTION_MUTATION: RISK_LEVELS.CRITICAL,
});

const LEGACY_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const LEGACY_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
  QUARANTINE: 'quarantine',
  HUMAN_REVIEW: 'human_review',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const nested = value[key];
    if (nested && typeof nested === 'object') {
      deepFreeze(nested);
    }
  }
  return value;
}

function toArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  return [String(value)];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function looksLikeProductionTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const values = [target.value, target.env, target.scope, target.target].filter(Boolean).map((v) => String(v).trim().toLowerCase());
  return values.some((value) => ['prod', 'production', 'live', 'canonical'].includes(value));
}

function normalizeCategoryToken(input) {
  if (input === null || input === undefined) {
    return null;
  }
  const token = String(input).trim();
  if (!token) {
    return null;
  }
  const canonical = token.replace(/[\s\-]+/g, '_').replace(/__+/g, '_').toUpperCase();
  if (ACTION_CATEGORIES[canonical]) {
    return canonical;
  }
  if (CATEGORY_ALIASES[canonical]) {
    return CATEGORY_ALIASES[canonical];
  }
  return null;
}

function normalizeActionType(actionType) {
  return normalizeCategoryToken(actionType);
}

function normalizeActionDecision(decisionInput) {
  if (isPlainObject(decisionInput)) {
    const out = {
      ok: decisionInput.ok !== false,
      actionType: normalizeActionType(decisionInput.actionType ?? decisionInput.category ?? decisionInput.actionCategory),
      category: normalizeActionType(decisionInput.category ?? decisionInput.actionType ?? decisionInput.actionCategory),
      actionCategory: normalizeActionType(decisionInput.actionCategory ?? decisionInput.category ?? decisionInput.actionType),
      riskLevel: normalizeRiskLevel(decisionInput.riskLevel),
      decision: normalizeDecision(decisionInput.decision),
      reasons: uniqueStrings(toArray(decisionInput.reasons)),
      flags: uniqueStrings(toArray(decisionInput.flags)),
      hardBlocked: Boolean(decisionInput.hardBlocked),
      trustReceipt: decisionInput.trustReceipt ? normalizeTrustReceipt(decisionInput.trustReceipt) : null,
      policyVersion: typeof decisionInput.policyVersion === 'string' ? decisionInput.policyVersion : POLICY_VERSION,
      target: cloneTarget(decisionInput.target),
      reason: typeof decisionInput.reason === 'string' ? decisionInput.reason : null,
    };
    if (!out.reason && out.reasons.length > 0) {
      out.reason = out.reasons[0];
    }
    return deepFreeze(out);
  }

  return deepFreeze({
    ok: true,
    actionType: null,
    category: null,
    actionCategory: null,
    riskLevel: RISK_LEVELS.HIGH,
    decision: ACTION_DECISIONS.HUMAN_REVIEW,
    reasons: [],
    flags: [FLAGS.MALFORMED_ACTION],
    hardBlocked: false,
    trustReceipt: deepFreeze({
      policyVersion: POLICY_VERSION,
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: [],
      flags: [FLAGS.MALFORMED_ACTION],
      hardBlocked: false,
      timestamp: null,
      target: null,
      reason: 'Malformed action input',
    }),
    policyVersion: POLICY_VERSION,
    target: null,
    reason: 'Malformed action input',
  });
}

function normalizeRiskLevel(level) {
  if (typeof level !== 'string') {
    return RISK_LEVELS.HIGH;
  }
  const normalized = level.trim().toUpperCase();
  return RISK_LEVELS[normalized] || RISK_LEVELS.HIGH;
}

function normalizeDecision(decision) {
  if (typeof decision !== 'string') {
    return ACTION_DECISIONS.HUMAN_REVIEW;
  }
  const normalized = decision.trim().toUpperCase();
  return ACTION_DECISIONS[normalized] || ACTION_DECISIONS.HUMAN_REVIEW;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function cloneTarget(target) {
  if (target === null || target === undefined) {
    return null;
  }
  if (typeof target === 'string') {
    return { value: target };
  }
  if (!isPlainObject(target)) {
    return { value: String(target) };
  }
  return { ...target };
}

function normalizeFlags(inputFlags) {
  const rawFlags = toArray(inputFlags);
  const normalized = [];
  for (const flag of rawFlags) {
    const token = String(flag).trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/__+/g, '_');
    if (token === 'auto_merge' || token === 'auto_merge_requested') {
      normalized.push(FLAGS.AUTO_MERGE);
    } else if (token === 'auto_deploy' || token === 'auto_deployment') {
      normalized.push(FLAGS.AUTO_DEPLOY);
    } else if (token === 'self_escalation' || token === 'self_escalate') {
      normalized.push(FLAGS.SELF_ESCALATION);
    } else if (token === 'malformed_action') {
      normalized.push(FLAGS.MALFORMED_ACTION);
    } else if (token === 'unknown_action_category') {
      normalized.push(FLAGS.UNKNOWN_ACTION_CATEGORY);
    } else if (token === 'path_security_sensitive') {
      normalized.push(FLAGS.PATH_SECURITY_SENSITIVE);
    } else if (token === 'path_outside_allowlist') {
      normalized.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
    } else if (token === 'url_outside_allowlist') {
      normalized.push(FLAGS.URL_OUTSIDE_ALLOWLIST);
    } else if (token === 'production_side' || token === 'production') {
      normalized.push(FLAGS.PRODUCTION_SIDE);
    } else if (token === 'bypass_admission' || token === 'bypass-admission') {
      normalized.push(FLAGS.BYPASS_ADMISSION);
    } else if (token === 'real_db' || token === 'real-db') {
      normalized.push(FLAGS.REAL_DB);
    } else if (token === 'ungated' || token === 'ungated_tool_chain') {
      normalized.push(FLAGS.UNGATED_TOOL_CHAIN);
    } else if (token === 'explicit_human_approval') {
      normalized.push(FLAGS.EXPLICIT_HUMAN_APPROVAL);
    } else {
      normalized.push(String(flag));
    }
  }
  return uniqueStrings(normalized);
}

function normalizeActionRequest(action) {
  if (!isPlainObject(action)) {
    return {
      malformed: true,
      rawCategory: null,
      category: null,
      action: null,
      target: null,
      context: {},
      flags: [FLAGS.MALFORMED_ACTION],
    };
  }

  const rawCategory = action.category ?? action.actionType ?? action.type ?? null;
  const category = normalizeActionType(rawCategory);
  const target = cloneTarget(action.target);
  const context = isPlainObject(action.context) ? { ...action.context } : {};
  const flags = uniqueStrings([
    ...normalizeFlags(action.flags),
    ...normalizeFlags(action.context?.flags),
  ]);

  return {
    malformed: false,
    rawCategory,
    category,
    action: typeof action.action === 'string' ? action.action : null,
    target,
    context,
    flags,
    now: action.now ?? action.timestamp ?? null,
    reason: typeof action.reason === 'string' ? action.reason : null,
  };
}

function classifyActionCategory(action) {
  const normalized = normalizeActionRequest(action);
  return normalized.malformed ? null : normalized.category;
}

function resolveRiskLevel(category) {
  if (!category || !ACTION_CATEGORIES[category]) {
    return RISK_LEVELS.HIGH;
  }
  return RISK_BY_CATEGORY[category] || RISK_LEVELS.HIGH;
}

function deriveDecision(riskLevel, hardBlocked) {
  if (hardBlocked) {
    return ACTION_DECISIONS.BLOCK;
  }
  switch (normalizeRiskLevel(riskLevel)) {
    case RISK_LEVELS.LOW:
      return ACTION_DECISIONS.ALLOW;
    case RISK_LEVELS.MEDIUM:
      return ACTION_DECISIONS.QUARANTINE;
    case RISK_LEVELS.HIGH:
      return ACTION_DECISIONS.HUMAN_REVIEW;
    case RISK_LEVELS.CRITICAL:
      return ACTION_DECISIONS.BLOCK;
    default:
      return ACTION_DECISIONS.HUMAN_REVIEW;
  }
}

function isPathInList(path, allowlistedPaths) {
  const normalizedPath = normalizePath(path);
  const list = toArray(allowlistedPaths).map(normalizePath).filter(Boolean);
  if (!normalizedPath || list.length === 0) {
    return false;
  }
  return list.some((allowed) => normalizedPath === allowed || normalizedPath.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`));
}

function isUrlInList(url, allowlistedUrls) {
  const normalizedUrl = normalizeUrl(url);
  const list = toArray(allowlistedUrls).map(normalizeUrl).filter(Boolean);
  if (!normalizedUrl || list.length === 0) {
    return false;
  }
  return list.some((allowed) => normalizedUrl === allowed || normalizedUrl.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`));
}

function isPathSecuritySensitive(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return false;
  }
  return SECURITY_SENSITIVE_PATH_TOKENS.some((token) => normalizedPath.endsWith(normalizePath(token)) || normalizedPath.includes(`/${normalizePath(token)}`));
}

function buildTrustReceipt(partial) {
  return deepFreeze({
    policyVersion: POLICY_VERSION,
    actionType: partial.actionType,
    category: partial.category,
    actionCategory: partial.actionCategory,
    riskLevel: partial.riskLevel,
    decision: partial.decision,
    reasons: [...partial.reasons],
    flags: [...partial.flags],
    hardBlocked: Boolean(partial.hardBlocked),
    timestamp: normalizeTimestamp(partial.timestamp),
    target: cloneTarget(partial.target),
    reason: partial.reason || (partial.reasons[0] ?? null),
  });
}

function normalizeResultShape(partial) {
  const reasons = uniqueStrings(toArray(partial.reasons));
  const flags = uniqueStrings(toArray(partial.flags));
  const category = partial.category ?? null;
  const decision = normalizeDecision(partial.decision);
  const riskLevel = normalizeRiskLevel(partial.riskLevel);
  const actionType = category;
  const actionCategory = category;
  const trustReceipt = partial.trustReceipt ? normalizeTrustReceipt(partial.trustReceipt) : buildTrustReceipt({
    actionType,
    category,
    actionCategory,
    riskLevel,
    decision,
    reasons,
    flags,
    hardBlocked: Boolean(partial.hardBlocked),
    timestamp: partial.timestamp ?? null,
    target: partial.target ?? null,
    reason: partial.reason ?? null,
  });

  return deepFreeze({
    ok: true,
    actionType,
    category,
    actionCategory,
    riskLevel,
    decision,
    reasons,
    flags,
    hardBlocked: Boolean(partial.hardBlocked),
    requiredReview: decision !== ACTION_DECISIONS.ALLOW,
    blocked: decision !== ACTION_DECISIONS.ALLOW,
    policyVersion: POLICY_VERSION,
    target: cloneTarget(partial.target),
    action: typeof partial.action === 'string' ? partial.action : null,
    reason: partial.reason ?? (reasons[0] ?? null),
    trustReceipt,
  });
}

function normalizeTrustReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    return buildTrustReceipt({
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: [],
      flags: [FLAGS.MALFORMED_ACTION],
      hardBlocked: false,
      timestamp: null,
      target: null,
      reason: 'Malformed trust receipt',
    });
  }

  return buildTrustReceipt({
    actionType: normalizeActionType(receipt.actionType ?? receipt.category ?? receipt.actionCategory),
    category: normalizeActionType(receipt.category ?? receipt.actionType ?? receipt.actionCategory),
    actionCategory: normalizeActionType(receipt.actionCategory ?? receipt.category ?? receipt.actionType),
    riskLevel: normalizeRiskLevel(receipt.riskLevel),
    decision: normalizeDecision(receipt.decision),
    reasons: uniqueStrings(toArray(receipt.reasons)),
    flags: uniqueStrings(toArray(receipt.flags)),
    hardBlocked: Boolean(receipt.hardBlocked),
    timestamp: receipt.timestamp ?? null,
    target: cloneTarget(receipt.target),
    reason: typeof receipt.reason === 'string' ? receipt.reason : null,
  });
}

function applyHardBlockRules(input, partial) {
  const contextFlags = uniqueStrings([
    ...normalizeFlags(input?.flags),
    ...normalizeFlags(input?.context?.flags),
  ]);
  const out = {
    ...partial,
    flags: uniqueStrings([...(partial.flags || []), ...contextFlags]),
    reasons: [...(partial.reasons || [])],
  };

  const category = out.category;
  const target = out.target || null;
  const hasFlag = (flag) => out.flags.includes(flag);

  if (hasFlag(FLAGS.AUTO_MERGE)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Auto-merge is blocked.');
  }

  if (hasFlag(FLAGS.AUTO_DEPLOY)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Auto-deploy is blocked.');
  }

  if (hasFlag(FLAGS.SELF_ESCALATION)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Self-escalation is blocked.');
  }

  if (category === ACTION_CATEGORIES.SECURITY_POLICY_CHANGE) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Security policy changes default to block.');
  }

  if (category === ACTION_CATEGORIES.DEPLOYMENT || category === ACTION_CATEGORIES.PERMISSION_CHANGE || category === ACTION_CATEGORIES.PRODUCTION_MUTATION) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Production-side mutation is blocked.');
  }

  if (category === ACTION_CATEGORIES.MEMORY_WRITE || category === ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE || category === ACTION_CATEGORIES.CODE_CHANGE || category === ACTION_CATEGORIES.TEST_CHANGE) {
    if (hasFlag(FLAGS.BYPASS_ADMISSION) || looksLikeProductionTarget(target)) {
      out.decision = ACTION_DECISIONS.BLOCK;
      out.hardBlocked = true;
      out.riskLevel = RISK_LEVELS.CRITICAL;
      out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.PRODUCTION_SIDE);
      out.reasons.push('Admission bypass or production-side target is blocked.');
    }
  }

  if (category === ACTION_CATEGORIES.SANDBOX_SIMULATION && (hasFlag(FLAGS.REAL_DB) || looksLikeProductionTarget(target))) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.REAL_DB);
    out.reasons.push('Sandbox must not write to a real DB.');
  }

  if (category === ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION && (hasFlag(FLAGS.UNGATED_TOOL_CHAIN) || hasFlag(FLAGS.SELF_ESCALATION))) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.UNGATED_TOOL_CHAIN);
    out.reasons.push('Tool-chain execution must be gated.');
  }

  if (target && target.path && isPathSecuritySensitive(target.path)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.PATH_SECURITY_SENSITIVE);
    out.reasons.push('Security-sensitive path is blocked.');
  }

  out.flags = uniqueStrings(out.flags);
  out.reasons = uniqueStrings(out.reasons);
  return out;
}

function classifyAgentAction(actionInput, options = {}) {
  const normalized = normalizeActionRequest(actionInput);
  const optFlags = uniqueStrings([
    ...normalizeFlags(options.flags),
    ...normalizeFlags(options.context?.flags),
  ]);

  if (normalized.malformed || !normalized.category) {
    const base = normalizeResultShape({
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: normalized.malformed ? ['Malformed action input'] : ['Unknown action category'],
      flags: uniqueStrings([
        ...normalized.flags,
        ...optFlags,
        normalized.malformed ? FLAGS.MALFORMED_ACTION : FLAGS.UNKNOWN_ACTION_CATEGORY,
      ]),
      hardBlocked: false,
      target: normalized.target,
      action: normalized.action,
      timestamp: normalizeTimestamp(options.now ?? normalized.now),
      reason: normalized.malformed ? 'Malformed action input' : 'Unknown action category',
    });
    return base;
  }

  const category = normalized.category;
  const allowlistedPaths = options.allowlistedPaths ?? normalized.context.allowlistedPaths ?? [];
  const allowlistedUrls = options.allowlistedUrls ?? normalized.context.allowlistedUrls ?? [];
  const target = normalized.target;
  const baseRisk = resolveRiskLevel(category);
  const partial = {
    actionType: category,
    category,
    actionCategory: category,
    riskLevel: baseRisk,
    decision: deriveDecision(baseRisk, false),
    flags: [...normalized.flags, ...optFlags],
    reasons: [],
    hardBlocked: false,
    target,
    action: normalized.action,
    timestamp: normalizeTimestamp(options.now ?? normalized.now),
    reason: null,
  };

  switch (category) {
    case ACTION_CATEGORIES.READ_ONLY: {
      if (target?.path && !isPathInList(target.path, allowlistedPaths)) {
        partial.riskLevel = RISK_LEVELS.HIGH;
        partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
        partial.flags.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
        partial.reasons.push('Read path is outside the allowlist.');
      } else {
        partial.riskLevel = RISK_LEVELS.LOW;
        partial.decision = ACTION_DECISIONS.ALLOW;
        partial.reasons.push('Read-only action stays low risk.');
      }
      break;
    }
    case ACTION_CATEGORIES.MEMORY_WRITE: {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      partial.reasons.push('Memory writes require review.');
      if (looksLikeProductionTarget(target)) {
        partial.flags.push(FLAGS.PRODUCTION_SIDE);
      }
      break;
    }
    case ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE: {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      partial.reasons.push('Canonical graph writes require review.');
      if (looksLikeProductionTarget(target)) {
        partial.flags.push(FLAGS.PRODUCTION_SIDE);
      }
      break;
    }
    case ACTION_CATEGORIES.CODE_CHANGE:
    case ACTION_CATEGORIES.TEST_CHANGE: {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      partial.reasons.push(`${category} requires human review.`);
      break;
    }
    case ACTION_CATEGORIES.SECURITY_POLICY_CHANGE: {
      partial.riskLevel = RISK_LEVELS.CRITICAL;
      partial.decision = ACTION_DECISIONS.BLOCK;
      partial.reasons.push('Security policy changes are blocked by default.');
      break;
    }
    case ACTION_CATEGORIES.DEPLOYMENT:
    case ACTION_CATEGORIES.PERMISSION_CHANGE:
    case ACTION_CATEGORIES.PRODUCTION_MUTATION: {
      partial.riskLevel = RISK_LEVELS.CRITICAL;
      partial.decision = ACTION_DECISIONS.BLOCK;
      partial.reasons.push('Production-side actions are blocked.');
      break;
    }
    case ACTION_CATEGORIES.FILESYSTEM_WRITE: {
      if (target?.path && isPathSecuritySensitive(target.path)) {
        partial.riskLevel = RISK_LEVELS.CRITICAL;
        partial.decision = ACTION_DECISIONS.BLOCK;
        partial.flags.push(FLAGS.PATH_SECURITY_SENSITIVE);
        partial.reasons.push('Security-sensitive path is blocked.');
      } else if (target?.path && isPathInList(target.path, allowlistedPaths)) {
        partial.riskLevel = RISK_LEVELS.MEDIUM;
        partial.decision = ACTION_DECISIONS.QUARANTINE;
        partial.reasons.push('Write path is allowlisted and quarantined.');
      } else {
        partial.riskLevel = RISK_LEVELS.HIGH;
        partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
        if (target?.path) {
          partial.flags.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
        }
        partial.reasons.push('Filesystem write requires review.');
      }
      break;
    }
    case ACTION_CATEGORIES.NETWORK_CALL: {
      if (target?.url && isUrlInList(target.url, allowlistedUrls)) {
        partial.riskLevel = RISK_LEVELS.MEDIUM;
        partial.decision = ACTION_DECISIONS.QUARANTINE;
        partial.reasons.push('Network destination is allowlisted and quarantined.');
      } else {
        partial.riskLevel = RISK_LEVELS.HIGH;
        partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
        if (target?.url) {
          partial.flags.push(FLAGS.URL_OUTSIDE_ALLOWLIST);
        }
        partial.reasons.push('Unknown network destination requires review.');
      }
      break;
    }
    case ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION: {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      partial.reasons.push('Tool-chain execution requires review.');
      break;
    }
    case ACTION_CATEGORIES.SANDBOX_SIMULATION: {
      partial.riskLevel = RISK_LEVELS.MEDIUM;
      partial.decision = ACTION_DECISIONS.QUARANTINE;
      partial.reasons.push('Sandbox simulation is quarantined.');
      break;
    }
    default: {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      partial.flags.push(FLAGS.UNKNOWN_ACTION_CATEGORY);
      partial.reasons.push('Unknown action category is never silently allowed.');
      break;
    }
  }

  const hardened = applyHardBlockRules({
    context: {
      flags: [...normalized.flags, ...optFlags],
    },
  }, partial);

  if (hardened.decision === ACTION_DECISIONS.BLOCK) {
    hardened.flags.push(FLAGS.HARD_BLOCKED);
  }

  hardened.reason = hardened.reason || hardened.reasons[0] || null;
  hardened.timestamp = normalizeTimestamp(options.now ?? normalized.now);
  hardened.trustReceipt = buildTrustReceipt(hardened);
  return normalizeResultShape(hardened);
}

function classify(actionInput, options = {}) {
  return classifyAgentAction(actionInput, options);
}

module.exports = {
  ACTION_CATEGORIES,
  ACTION_TYPES: ACTION_CATEGORIES,
  ACTION_DECISIONS,
  DECISIONS: ACTION_DECISIONS,
  RISK_LEVELS,
  LEGACY_RISK_LEVELS,
  LEGACY_DECISIONS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  HIGH_IMPACT_WRITE_CATEGORIES,
  POLICY_VERSION,
  normalizeActionType,
  normalizeActionRequest,
  classifyActionCategory,
  resolveRiskLevel,
  deriveDecision,
  applyHardBlockRules,
  classifyAgentAction,
  classify,
  normalizeActionDecision,
  normalizeDecision,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
};
