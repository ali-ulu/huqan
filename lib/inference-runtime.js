'use strict';

/**
 * Production entry point for the inference layer (#3038).
 *
 * Every inference primitive under lib/inference-*.js was implemented and unit
 * tested but nothing in the product executed it: NOT_YET_WIRED classified the
 * whole family as "pure primitive, production caller lands separately". This
 * module is that caller. It composes the existing primitives into one bounded,
 * evidence-producing request instead of introducing a parallel engine:
 *
 *   rules + facts
 *     -> semi-naive forward evaluation (bounded fixpoint, explicit stop reason)
 *     -> one provisional DERIVED_RECORD per candidate (rule id + full support set
 *        + graph/rule snapshot ids, so the derivation is reproducible)
 *     -> optional admission through the EXISTING candidate ingress path
 *        (injected, never a new authority)
 *
 * Two invariants are structural, not conventional:
 *
 * 1. A derived fact is provisional. This module can only move a record to
 *    `admitted` by handing it to `admitDerivedRecord` with a caller-injected
 *    `ingestCandidateClaim`, i.e. the same admission path a hand-authored
 *    candidate claim takes. There is no second writer and no direct graph write.
 * 2. The graph snapshot and rule snapshot ids are part of the record, so the
 *    same snapshot + rule set reproduces the same derivationId. The stop reason
 *    from the bounded evaluator is carried out verbatim; a budget that ran out
 *    is never reported as a fixpoint.
 */

const crypto = require('node:crypto');
const { isPlainObject } = require('./is-plain-object');
const {
  constant,
  createRule,
  serializeRule,
} = require('./inference-rule-ir');
const { factKey } = require('./inference-semi-naive-values');
const { evaluateSemiNaive } = require('./inference-semi-naive');
const { proveBackward } = require('./inference-backward');
const { buildDerivedRecord } = require('./inference-derived-record');
const {
  DERIVED_ADMISSION_STATUS,
  admitDerivedRecord,
} = require('./inference-derived-admission');

const RUNTIME_STATUS = Object.freeze({
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const DEFAULT_LIMITS = Object.freeze({
  maxOperations: 100_000,
  maxRounds: 64,
  maxDerivedFacts: 10_000,
  timeoutMs: 1000,
});

function hash(parts) {
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 32);
}

function invalidResult(code, message) {
  return Object.freeze({
    status: RUNTIME_STATUS.INVALID,
    stoppedReason: 'invalid_input',
    error: Object.freeze({ code, message }),
    budget: null,
    rounds: 0,
    stats: null,
    snapshot: null,
    derivedFacts: Object.freeze([]),
    records: Object.freeze([]),
    admission: Object.freeze({ applied: false, admittedCount: 0, heldCount: 0 }),
  });
}

function normalizeRuleList(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('rules must be a non-empty array');
  }
  return input.map((rule) => (
    isPlainObject(rule) && typeof rule.schemaVersion === 'string' ? rule : createRule(rule)
  ));
}

function normalizeFactList(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('facts must be a non-empty array');
  }
  return input.map((raw) => {
    if (!isPlainObject(raw) || typeof raw.predicate !== 'string' || raw.predicate === '') {
      throw new TypeError('each fact needs a non-empty predicate');
    }
    // Accept the compact { predicate, from, to } shape the tool advertises, or
    // a full ground atom with explicit terms. Either way the result is ground.
    if (Array.isArray(raw.args)) return raw;
    if (typeof raw.from === 'string' && typeof raw.to === 'string') {
      return { predicate: raw.predicate, args: [constant(raw.from), constant(raw.to)] };
    }
    throw new TypeError(`fact ${raw.predicate} needs args or from/to`);
  });
}

function normalizeQuery(input) {
  if (!isPlainObject(input) || typeof input.predicate !== 'string' || input.predicate === '') {
    throw new TypeError('query needs a non-empty predicate');
  }
  if (Array.isArray(input.args)) return input;
  if (typeof input.from === 'string' && typeof input.to === 'string') {
    return { predicate: input.predicate, args: [constant(input.from), constant(input.to)] };
  }
  throw new TypeError(`query ${input.predicate} needs args or from/to`);
}

function normalizeLimits(input) {
  const limits = { ...DEFAULT_LIMITS, ...(isPlainObject(input) ? input : {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) return null;
  }
  return limits;
}

function projectFact(fact) {
  const values = fact.args.map((term) => term.value);
  if (fact.args.length === 2) {
    return Object.freeze({ predicate: fact.predicate, from: values[0], to: values[1] });
  }
  return Object.freeze({ predicate: fact.predicate, args: Object.freeze(values) });
}

function snapshotIds(input, rules, facts) {
  const factSnapshotId = typeof input.graphSnapshotId === 'string' && input.graphSnapshotId !== ''
    ? input.graphSnapshotId
    : `facts:${hash(facts.map(factKey).sort())}`;
  const ruleSnapshotId = typeof input.ruleSnapshotId === 'string' && input.ruleSnapshotId !== ''
    ? input.ruleSnapshotId
    : `rules:${hash(rules.map(serializeRule).sort())}`;
  return { factSnapshotId, ruleSnapshotId };
}

function supportDetailsFor(candidate) {
  return candidate.directSupports.map((fact) => ({
    fact,
    sourceRefs: [`fact:${factKey(fact)}`],
  }));
}

function admitCandidate(record, admission, at) {
  const admitted = admitDerivedRecord(record, admission, { at });
  return {
    record: admitted.record,
    admissionStatus: admitted.status,
    canonicalWrite: admitted.status === DERIVED_ADMISSION_STATUS.ADMITTED,
  };
}

function toDerivedFact(entry) {
  return Object.freeze({
    derivationId: entry.record.derivationId,
    ruleId: entry.record.ruleId,
    fact: projectFact(entry.record.fact),
    state: entry.record.state,
    admissionStatus: entry.admissionStatus,
    canonicalWrite: entry.canonicalWrite,
    trustReceiptId: entry.record.trustReceiptId || '',
  });
}

function evaluateForward(input, opts, limits) {
  const rules = normalizeRuleList(input.rules);
  const facts = normalizeFactList(input.facts);
  const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId !== ''
    ? input.workspaceId
    : 'default';
  const evaluation = evaluateSemiNaive(rules, facts, limits);
  if (evaluation.status === 'invalid') {
    return invalidResult('INVALID_RULES', evaluation.stoppedReason || 'invalid_input');
  }

  const { factSnapshotId, ruleSnapshotId } = snapshotIds(input, rules, facts);
  const derivedAt = typeof opts.now === 'string' && opts.now !== ''
    ? opts.now
    : new Date().toISOString();
  const admission = isPlainObject(opts.admission)
    && typeof opts.admission.ingestCandidateClaim === 'function'
    ? opts.admission
    : null;

  const entries = evaluation.derivedCandidates.map((candidate) => {
    const record = buildDerivedRecord(candidate, {
      workspaceId,
      graphSnapshotId: factSnapshotId,
      ruleSnapshotId,
      derivedAt,
      supportDetails: supportDetailsFor(candidate),
    });
    return admission
      ? admitCandidate(record, admission, derivedAt)
      : { record, admissionStatus: 'provisional', canonicalWrite: false };
  });

  const admittedCount = entries.filter((entry) => entry.canonicalWrite).length;
  const derivedFacts = Object.freeze(entries.map(toDerivedFact));
  return Object.freeze({
    status: evaluation.status === 'complete' ? RUNTIME_STATUS.COMPLETE : RUNTIME_STATUS.STOPPED,
    stoppedReason: evaluation.stoppedReason,
    error: null,
    budget: Object.freeze({ ...limits }),
    rounds: evaluation.rounds,
    stats: evaluation.stats,
    snapshot: Object.freeze({ graphSnapshotId: factSnapshotId, ruleSnapshotId }),
    derivedFacts,
    records: Object.freeze(entries.map((entry) => entry.record)),
    admission: Object.freeze({
      applied: Boolean(admission),
      admittedCount,
      heldCount: derivedFacts.length - admittedCount,
    }),
  });
}

/**
 * Derive previously unstored facts from a general rule set over the supplied
 * ground facts, under a bounded budget.
 *
 * @param {{rules: object[], facts: object[], workspaceId?: string,
 *   graphSnapshotId?: string, ruleSnapshotId?: string}} input
 * @param {{now?: string, limits?: object, admission?: {ingestCandidateClaim: Function, verifyDerived?: Function}}} opts
 * @returns frozen result; `derivedFacts` are provisional unless `opts.admission`
 *   routed them through the existing candidate ingress and admission allowed it.
 */
function deriveFromRules(input = {}, opts = {}) {
  if (!isPlainObject(input)) return invalidResult('INVALID_INPUT', 'input must be an object');
  const limits = normalizeLimits(opts.limits);
  if (!limits) return invalidResult('INVALID_LIMITS', 'limits must be positive integers');
  try {
    return evaluateForward(input, opts, limits);
  } catch (error) {
    return invalidResult('INVALID_INPUT', error && error.message ? error.message : 'invalid_input');
  }
}

/**
 * Bounded query-time proof of a single ground fact over the same rule set.
 * Returns the prover's status/reason verbatim; an unfinished proof is `unknown`
 * or `stopped`, never a silent `not_proven` downgrade.
 */
function proveFromRules(input = {}, opts = {}) {
  if (!isPlainObject(input)) return invalidResult('INVALID_INPUT', 'input must be an object');
  const limits = normalizeLimits(opts.limits);
  if (!limits) return invalidResult('INVALID_LIMITS', 'limits must be positive integers');
  try {
    const rules = normalizeRuleList(input.rules);
    const facts = normalizeFactList(input.facts);
    const query = normalizeQuery(input.query);
    const result = proveBackward(query, rules, facts, limits);
    return Object.freeze({
      status: result.status,
      reason: result.reason,
      operations: result.operations,
      proof: result.proof,
      error: null,
    });
  } catch (error) {
    return invalidResult('INVALID_INPUT', error && error.message ? error.message : 'invalid_input');
  }
}

module.exports = {
  RUNTIME_STATUS,
  DEFAULT_LIMITS,
  deriveFromRules,
  proveFromRules,
};
