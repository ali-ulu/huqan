'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../receipt/canonical-receipt');
const { CANONICAL_VERDICTS } = require('../verdict/action-verdict');

// Null-prototype, so a verdict name is only ever looked up among the verdicts
// themselves. As plain object literals these inherited from Object.prototype,
// which is what let a lookup for 'constructor' or 'toString' return a function
// instead of undefined and walk straight past the fail-closed guard below
// (#1034 — same root cause as #1033 in evidence-ranker).
const PREVENTION_PRIORITY = Object.freeze(Object.assign(Object.create(null), { allow: 0, review: 1, block: 2 }));
const CANONICAL_PRIORITY = Object.freeze(Object.assign(Object.create(null), { allow: 0, disabled: 1, review: 2, dry_run_only: 3, quarantine: 4, block: 5 }));
const CANONICAL_SET = new Set(CANONICAL_VERDICTS);

function makeId(prefix, value) {
  const digest = crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
  return `${prefix}_${digest.slice(0, 24)}`;
}

function ruleDecision(enforcement) {
  if (enforcement === 'block') return 'block';
  if (enforcement === 'require_verify') return 'review';
  return 'allow';
}

/**
 * Both sides fall closed to 'block' when the verdict is not one this module
 * knows.
 *
 * The prevention side used `PREVENTION_PRIORITY[v] === undefined`, which a
 * prototype key name passes: the lookup returned a function, the guard did not
 * fire, and the raw input was carried through as the merged verdict. Both
 * ranks were then functions, `>=` compared false, and the caller received a
 * non-canonical string. buildPreflightDecision turns that into
 * `allowed: false, requiresReview: false, blocked: false` — neither permitted
 * nor stopped, so a caller checking `if (!result.blocked)` proceeds. A guard
 * that fail-closes 'bogus' but not 'constructor' gives false assurance
 * precisely where a security default is supposed to hold (#1034).
 *
 * `Object.hasOwn` asks the question the guard meant to ask, and keeps holding
 * if these tables are ever built some other way.
 */
function mergeWithUpstreamVerdict(upstreamVerdict = 'allow', preventionVerdict = 'allow') {
  const upstream = CANONICAL_SET.has(upstreamVerdict) ? upstreamVerdict : 'block';
  const prevention = Object.hasOwn(PREVENTION_PRIORITY, preventionVerdict) ? preventionVerdict : 'block';
  const upstreamRank = CANONICAL_PRIORITY[upstream];
  const preventionRank = CANONICAL_PRIORITY[prevention];
  return upstreamRank >= preventionRank ? upstream : prevention;
}

function matchesRule(rule, action) {
  const trigger = rule.trigger || {};
  if (trigger.actionFingerprint && trigger.actionFingerprint !== action.actionFingerprint) return false;
  for (const field of ['tool', 'operation', 'repo', 'path']) {
    if (trigger[field] && trigger[field] !== action[field]) return false;
  }
  return true;
}

function buildPreflightDecision(action, rules, policyVersion, options = {}) {
  const matches = rules.filter((rule) => matchesRule(rule, action));
  let preventionDecision = 'allow';
  for (const rule of matches) {
    // ruleDecision() only ever returns allow/review/block, so these lookups are
    // already safe; the null prototype above is what keeps them that way.
    const next = ruleDecision(rule.enforcement);
    if (PREVENTION_PRIORITY[next] > PREVENTION_PRIORITY[preventionDecision]) preventionDecision = next;
  }

  const upstreamVerdict = options.upstreamVerdict || 'allow';
  const invalidUpstream = !CANONICAL_SET.has(upstreamVerdict);
  let decision = mergeWithUpstreamVerdict(upstreamVerdict, preventionDecision);
  const integrityFindings = (Array.isArray(options.integrityFindings) ? options.integrityFindings : [])
    .filter((item) => matchesRule({ trigger: item?.trigger || {} }, action));
  if (integrityFindings.length > 0) decision = mergeWithUpstreamVerdict(decision, 'review');

  const reasonCodes = matches.length === 0
    ? ['NO_PREVIOUS_VERIFIED_FAILURE']
    : ['PREVIOUS_VERIFIED_FAILURE', `PREVENTION_${preventionDecision.toUpperCase()}`];
  if (invalidUpstream) reasonCodes.push('UNKNOWN_UPSTREAM_VERDICT_BLOCKED');
  else if (decision !== preventionDecision && integrityFindings.length === 0) reasonCodes.push('STRICTER_UPSTREAM_VERDICT_PRESERVED');
  if (integrityFindings.length > 0) reasonCodes.push('ACTIVE_RULE_INTEGRITY_REVIEW');

  const matchedRuleIds = new Set(matches.map((rule) => rule.ruleId));
  const matchedEvidenceRefs = (Array.isArray(options.evidenceRefs) ? options.evidenceRefs : [])
    .filter((ref) => matchedRuleIds.has(ref.ruleId));
  const payload = {
    kind: 'error_prevention_preflight_receipt', policyVersion, decision,
    upstreamVerdict: invalidUpstream ? 'invalid' : upstreamVerdict,
    preventionDecision, action,
    matchedRuleIds: matches.map((rule) => rule.ruleId),
    matchedFailureIds: matches.map((rule) => rule.sourceFailureId),
    matchedEvidenceRefs, integrityFindings, reasonCodes,
  };
  return {
    ok: true, decision, upstreamVerdict, preventionDecision,
    allowed: decision === 'allow', requiresReview: decision === 'review', blocked: decision === 'block',
    reasonCodes, matchedRules: matches, matchedEvidenceRefs, integrityFindings,
    remediation: matches.map((rule) => rule.remediation).filter(Boolean),
    receipt: { ...payload, receiptId: makeId('ep_receipt', payload), createdAt: new Date().toISOString() },
  };
}

module.exports = { CANONICAL_PRIORITY, PREVENTION_PRIORITY, buildPreflightDecision, makeId, matchesRule, mergeWithUpstreamVerdict };
