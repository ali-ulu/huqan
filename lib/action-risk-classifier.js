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

const DECISIONS = Object.freeze({
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
  UNKNOWN_ACTION_CATEGORY: 'UNKNOWN_ACTION_CATEGORY',
  UNKNOWN_CATEGORY_FAILSAFE: 'UNKNOWN_CATEGORY_FAILSAFE',
  PATH_OUTSIDE_ALLOWLIST: 'PATH_OUTSIDE_ALLOWLIST',
  PATH_SECURITY_SENSITIVE: 'PATH_SECURITY_SENSITIVE',
  URL_OUTSIDE_ALLOWLIST: 'URL_OUTSIDE_ALLOWLIST',
  MALFORMED_ACTION: 'MALFORMED_ACTION',
  UNKNOWN_HIGH_IMPACT_WRITE: 'UNKNOWN_HIGH_IMPACT_WRITE',
  PRODUCTION_SIDE: 'PRODUCTION_SIDE',
});

const SECURITY_SENSITIVE_PATH_TOKENS = Object.freeze([
  'requestGuards.js',
  'server.js',
  'toolPolicy.js',
  'lib/action-risk-classifier.js',
  'lib/trust-policy.js',
  'lib/risk-rules.js',
  'docs/SECURITY-GATE.md',
  'docs/agent-brake-layer.md',
  'docs/action-taxonomy.md',
]);

const HIGH_IMPACT_WRITE_CATEGORIES = Object.freeze(new Set([
  ACTION_CATEGORIES.MEMORY_WRITE,
  ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE,
  ACTION_CATEGORIES.CODE_CHANGE,
  ACTION_CATEGORIES.TEST_CHANGE,
  ACTION_CATEGORIES.SECURITY_POLICY_CHANGE,
  ACTION_CATEGORIES.DEPLOYMENT,
  ACTION_CATEGORIES.PERMISSION_CHANGE,
  ACTION_CATEGORIES.PRODUCTION_MUTATION,
]));

const KNOWN_CATEGORY_SET = new Set(Object.values(ACTION_CATEGORIES));

const CATEGORY_DEFAULT_MATRIX = Object.freeze({
  [ACTION_CATEGORIES.READ_ONLY]: Object.freeze({
    riskLevel: RISK_LEVELS.LOW,
    decision: DECISIONS.ALLOW,
  }),
  [ACTION_CATEGORIES.MEMORY_WRITE]: Object.freeze({
    riskLevel: RISK_LEVELS.HIGH,
    decision: DECISIONS.HUMAN_REVIEW,
  }),
  [ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE]: Object.freeze({
    riskLevel: RISK_LEVELS.HIGH,
    decision: DECISIONS.HUMAN_REVIEW,
  }),
  [ACTION_CATEGORIES.CODE_CHANGE]: Object.freeze({
    riskLevel: RISK_LEVELS.HIGH,
    decision: DECISIONS.HUMAN_REVIEW,
  }),
  [ACTION_CATEGORIES.TEST_CHANGE]: Object.freeze({
    riskLevel: RISK_LEVELS.HIGH,
    decision: DECISIONS.HUMAN_REVIEW,
  }),
  [ACTION_CATEGORIES.SECURITY_POLICY_CHANGE]: Object.freeze({
    riskLevel: RISK_LEVELS.CRITICAL,
    decision: DECISIONS.BLOCK,
  }),
  [ACTION_CATEGORIES.DEPLOYMENT]: Object.freeze({
    riskLevel: RISK_LEVELS.CRITICAL,
    decision: DECISIONS.BLOCK,
  }),
  [ACTION_CATEGORIES.PERMISSION_CHANGE]: Object.freeze({
    riskLevel: RISK_LEVELS.CRITICAL,
    decision: DECISIONS.BLOCK,
  }),
  [ACTION_CATEGORIES.FILESYSTEM_WRITE]: Object.freeze({
    riskLevel: RISK_LEVELS.MEDIUM,
    decision: DECISIONS.QUARANTINE,
  }),
  [ACTION_CATEGORIES.NETWORK_CALL]: Object.freeze({
    riskLevel: RISK_LEVELS.MEDIUM,
    decision: DECISIONS.QUARANTINE,
  }),
  [ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION]: Object.freeze({
    riskLevel: RISK_LEVELS.HIGH,
    decision: DECISIONS.HUMAN_REVIEW,
  }),
  [ACTION_CATEGORIES.SANDBOX_SIMULATION]: Object.freeze({
    riskLevel: RISK_LEVELS.MEDIUM,
    decision: DECISIONS.QUARANTINE,
  }),
  [ACTION_CATEGORIES.PRODUCTION_MUTATION]: Object.freeze({
    riskLevel: RISK_LEVELS.CRITICAL,
    decision: DECISIONS.BLOCK,
  }),
});

function asString(value) {
  if (value == null) return '';
  return String(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function normalizePath(value) {
  const raw = asString(value).trim();
  if (!raw) return '';
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isPathInsideRoot(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const target = normalizePath(targetPath);
  const root = normalizePath(rootPath);
  if (!target || !root) return false;
  const rootNoSlash = root.endsWith('/') ? root.slice(0, -1) : root;
  if (!rootNoSlash) return false;
  if (target === rootNoSlash) return true;
  return target.startsWith(`${rootNoSlash}/`);
}

function isPathInList(targetPath, list) {
  if (!isStringArray(list) || list.length === 0) return false;
  const target = normalizePath(targetPath);
  if (!target) return false;
  return list.some(item => {
    const root = normalizePath(item);
    return root ? isPathInsideRoot(target, root) : false;
  });
}

function isUrlInList(targetUrl, list) {
  if (!isStringArray(list) || list.length === 0) return false;
  const url = asString(targetUrl).trim();
  if (!url) return false;
  return list.some(item => {
    const candidate = asString(item).trim();
    if (!candidate) return false;
    return url === candidate || url.startsWith(`${candidate}/`);
  });
}

function isPathSecuritySensitive(targetPath) {
  const path = normalizePath(targetPath);
  if (!path) return false;
  return SECURITY_SENSITIVE_PATH_TOKENS.some(token => {
    const needle = normalizePath(token);
    if (!needle) return false;
    return path === needle || path.endsWith(`/${needle}`);
  });
}

function pickReasons({ category, riskLevel, decision, reasonList }) {
  const reasons = [];
  if (reasonList && reasonList.length > 0) reasons.push(...reasonList);
  reasons.push(`category=${category}`);
  reasons.push(`riskLevel=${riskLevel}`);
  reasons.push(`decision=${decision}`);
  return reasons;
}

function buildTrustReceipt({ action, category, riskLevel, decision, reasons, flags, now }) {
  const receipt = {
    action: action || null,
    category,
    riskLevel,
    decision,
    reasons: [...reasons],
    flags: [...flags],
  };
  if (now != null) {
    const numeric = typeof now === 'number' ? now : Number(now);
    if (Number.isFinite(numeric)) {
      receipt.timestamp = numeric;
    }
  }
  return receipt;
}

function freezeResult(result) {
  if (result.trustReceipt) {
    result.trustReceipt = Object.freeze(result.trustReceipt);
  }
  return Object.freeze(result);
}

function applyOverrides({ matrix, overrides }) {
  if (!overrides || typeof overrides !== 'object') return matrix;
  const next = { ...matrix };
  for (const key of Object.keys(overrides)) {
    const override = overrides[key];
    if (!override) continue;
    const merged = { ...matrix[key] };
    if (typeof override.riskLevel === 'string' && Object.values(RISK_LEVELS).includes(override.riskLevel)) {
      merged.riskLevel = override.riskLevel;
    }
    if (typeof override.decision === 'string' && Object.values(DECISIONS).includes(override.decision)) {
      merged.decision = override.decision;
    }
    next[key] = Object.freeze(merged);
  }
  return Object.freeze(next);
}

function classifyAction(action, options = {}) {
  let category = null;
  let actionId = null;
  let target = null;
  const reasons = [];
  const flags = [];
  let malformed = false;

  if (action == null || typeof action !== 'object') {
    malformed = true;
  } else {
    const rawCategory = asString(action.category).trim().toUpperCase();
    if (!rawCategory) {
      malformed = true;
    } else if (KNOWN_CATEGORY_SET.has(rawCategory)) {
      category = rawCategory;
    } else {
      category = rawCategory;
      flags.push(FLAGS.UNKNOWN_ACTION_CATEGORY);
    }

    if (typeof action.action === 'string' && action.action.trim()) {
      actionId = action.action.trim();
    }

    if (action.target == null) {
      target = null;
    } else if (typeof action.target === 'object') {
      target = action.target;
    } else {
      target = { value: asString(action.target) };
    }
  }

  if (malformed) {
    flags.push(FLAGS.MALFORMED_ACTION, FLAGS.UNKNOWN_ACTION_CATEGORY, FLAGS.UNKNOWN_CATEGORY_FAILSAFE);
  }

  const allowlistedPaths = isStringArray(options.allowlistedPaths) ? options.allowlistedPaths : null;
  const allowlistedUrls = isStringArray(options.allowlistedUrls) ? options.allowlistedUrls : null;
  const now = options.now;
  const overrides = options.overrides;

  const baseMatrix = applyOverrides({ matrix: CATEGORY_DEFAULT_MATRIX, overrides });

  let riskLevel;
  let decision;
  let reasonList = [];

  if (malformed) {
    riskLevel = RISK_LEVELS.HIGH;
    decision = DECISIONS.HUMAN_REVIEW;
    reasonList.push('Action input is malformed or missing category. Default fail-safe: HUMAN_REVIEW.');
  } else if (category && !KNOWN_CATEGORY_SET.has(category)) {
    riskLevel = RISK_LEVELS.HIGH;
    decision = DECISIONS.HUMAN_REVIEW;
    flags.push(FLAGS.UNKNOWN_CATEGORY_FAILSAFE);
    reasonList.push(`Unknown action category: ${category}. Default fail-safe: HUMAN_REVIEW.`);
  } else if (category && HIGH_IMPACT_WRITE_CATEGORIES.has(category)) {
    flags.push(FLAGS.UNKNOWN_HIGH_IMPACT_WRITE);
    if (allowlistedPaths && target && typeof target.path === 'string' && isPathInList(target.path, allowlistedPaths)) {
      const def = baseMatrix[category];
      riskLevel = def.riskLevel;
      decision = DECISIONS.QUARANTINE;
      reasonList.push(`High-impact write inside allowlisted path. Quarantined pending admission.`);
    } else {
      const def = baseMatrix[category];
      riskLevel = def.riskLevel;
      decision = def.decision;
      reasonList.push(`High-impact write category requires explicit approval.`);
    }
    if (target && typeof target.path === 'string' && isPathSecuritySensitive(target.path)) {
      flags.push(FLAGS.PATH_SECURITY_SENSITIVE);
      if (decision !== DECISIONS.BLOCK) {
        decision = DECISIONS.BLOCK;
        riskLevel = RISK_LEVELS.CRITICAL;
        reasonList.push('Target path is security-sensitive. Hardened default: BLOCK / CRITICAL.');
      } else {
        reasonList.push('Target path is security-sensitive. Default is already BLOCK.');
      }
    }
  } else if (category === ACTION_CATEGORIES.FILESYSTEM_WRITE) {
    if (allowlistedPaths && target && typeof target.path === 'string' && isPathInList(target.path, allowlistedPaths)) {
      riskLevel = RISK_LEVELS.MEDIUM;
      decision = DECISIONS.QUARANTINE;
      reasonList.push('Filesystem write inside allowlisted root. Quarantined.');
    } else {
      riskLevel = RISK_LEVELS.HIGH;
      decision = DECISIONS.HUMAN_REVIEW;
      flags.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
      reasonList.push('Filesystem write outside allowlisted root requires human review.');
    }
    if (target && typeof target.path === 'string' && isPathSecuritySensitive(target.path)) {
      flags.push(FLAGS.PATH_SECURITY_SENSITIVE);
      decision = DECISIONS.BLOCK;
      riskLevel = RISK_LEVELS.CRITICAL;
      reasonList.push('Target path is security-sensitive. Hardened default: BLOCK.');
    }
  } else if (category === ACTION_CATEGORIES.NETWORK_CALL) {
    if (allowlistedUrls && target && typeof target.url === 'string' && isUrlInList(target.url, allowlistedUrls)) {
      riskLevel = RISK_LEVELS.MEDIUM;
      decision = DECISIONS.QUARANTINE;
      reasonList.push('Network call to allowlisted destination. Quarantined.');
    } else {
      riskLevel = RISK_LEVELS.HIGH;
      decision = DECISIONS.HUMAN_REVIEW;
      flags.push(FLAGS.URL_OUTSIDE_ALLOWLIST);
      reasonList.push('Network call to non-allowlisted destination requires human review.');
    }
  } else if (category === ACTION_CATEGORIES.SANDBOX_SIMULATION) {
    riskLevel = RISK_LEVELS.MEDIUM;
    decision = DECISIONS.QUARANTINE;
    reasonList.push('Sandbox simulation must not touch production state.');
  } else if (category === ACTION_CATEGORIES.READ_ONLY) {
    if (allowlistedPaths && target && typeof target.path === 'string' && !isPathInList(target.path, allowlistedPaths)) {
      riskLevel = RISK_LEVELS.MEDIUM;
      decision = DECISIONS.QUARANTINE;
      flags.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
      reasonList.push('Read outside allowlisted root. Quarantined pending path check.');
    } else {
      riskLevel = RISK_LEVELS.LOW;
      decision = DECISIONS.ALLOW;
      reasonList.push('Read-only action inside allowlisted scope.');
    }
  } else if (category === ACTION_CATEGORIES.PRODUCTION_MUTATION) {
    riskLevel = RISK_LEVELS.CRITICAL;
    decision = DECISIONS.BLOCK;
    flags.push(FLAGS.PRODUCTION_SIDE);
    reasonList.push('Production mutation is blocked by default.');
  } else if (category && baseMatrix[category]) {
    const def = baseMatrix[category];
    riskLevel = def.riskLevel;
    decision = def.decision;
    reasonList.push(`Category default: riskLevel=${def.riskLevel}, decision=${def.decision}.`);
  } else {
    riskLevel = RISK_LEVELS.HIGH;
    decision = DECISIONS.HUMAN_REVIEW;
    flags.push(FLAGS.UNKNOWN_CATEGORY_FAILSAFE);
    reasonList.push('No matching matrix entry. Default fail-safe: HUMAN_REVIEW.');
  }

  const allReasons = pickReasons({ category, riskLevel, decision, reasonList });
  const trustReceipt = buildTrustReceipt({
    action: actionId,
    category: category || 'UNKNOWN',
    riskLevel,
    decision,
    reasons: allReasons,
    flags,
    now,
  });

  return freezeResult({
    decision,
    riskLevel,
    category: category || 'UNKNOWN',
    reasons: allReasons,
    flags,
    trustReceipt,
  });
}

module.exports = {
  ACTION_CATEGORIES,
  DECISIONS,
  RISK_LEVELS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  classifyAction,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
};
