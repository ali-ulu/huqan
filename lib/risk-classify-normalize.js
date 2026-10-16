"use strict";

// Input normalizers for lib/risk-classify.js (#2120): tokens, flags, targets,
// timestamps and the action request envelope. Pure functions, no I/O.
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  CATEGORY_ALIASES,
  FLAGS,
  RISK_LEVELS,
} = require('./risk-policy-constants');
const { isPlainObject } = require('./is-plain-object');

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

function normalizeCategoryToken(input) {
  if (input === null || input === undefined) {
    return null;
  }
  const token = String(input).trim();
  if (!token) {
    return null;
  }
  const canonical = token.replace(/[\s-]+/g, '_').replace(/__+/g, '_').toUpperCase();
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

/** Normalized flag token -> canonical flag. An alias is one more key, not a branch. */
const FLAG_ALIASES = Object.freeze({
  auto_merge: FLAGS.AUTO_MERGE,
  auto_merge_requested: FLAGS.AUTO_MERGE,
  auto_deploy: FLAGS.AUTO_DEPLOY,
  auto_deployment: FLAGS.AUTO_DEPLOY,
  self_escalation: FLAGS.SELF_ESCALATION,
  self_escalate: FLAGS.SELF_ESCALATION,
  malformed_action: FLAGS.MALFORMED_ACTION,
  unknown_action_category: FLAGS.UNKNOWN_ACTION_CATEGORY,
  path_security_sensitive: FLAGS.PATH_SECURITY_SENSITIVE,
  path_outside_allowlist: FLAGS.PATH_OUTSIDE_ALLOWLIST,
  url_outside_allowlist: FLAGS.URL_OUTSIDE_ALLOWLIST,
  production_side: FLAGS.PRODUCTION_SIDE,
  production: FLAGS.PRODUCTION_SIDE,
  bypass_admission: FLAGS.BYPASS_ADMISSION,
  real_db: FLAGS.REAL_DB,
  ungated: FLAGS.UNGATED_TOOL_CHAIN,
  ungated_tool_chain: FLAGS.UNGATED_TOOL_CHAIN,
  explicit_human_approval: FLAGS.EXPLICIT_HUMAN_APPROVAL,
});

function normalizeFlags(inputFlags) {
  const normalized = [];
  for (const flag of toArray(inputFlags)) {
    // Hyphens and spaces are folded to underscores first, so the dashed
    // spellings (bypass-admission, real-db) land on the same key.
    const token = String(flag).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/__+/g, '_');
    normalized.push(Object.prototype.hasOwnProperty.call(FLAG_ALIASES, token) ? FLAG_ALIASES[token] : String(flag));
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

module.exports = {
  deepFreeze,
  toArray,
  uniqueStrings,
  normalizeActionType,
  normalizeRiskLevel,
  normalizeDecision,
  normalizeTimestamp,
  cloneTarget,
  normalizeFlags,
  normalizeActionRequest,
};
