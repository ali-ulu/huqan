'use strict';

const crypto = require('crypto');
const { atom, constant, serializeRule, parseRule } = require('./inference-rule-ir');

const ABDUCTION_STATUS = Object.freeze({
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  INVALID: 'invalid',
});

const ABDUCTION_STOPPED = Object.freeze({
  FIXPOINT: 'complete_search',
  MAX_OPERATIONS: 'max_operations',
  MAX_CANDIDATES: 'max_candidates',
  MAX_MISSING_PREMISES: 'max_missing_premises',
  TIMEOUT: 'timeout',
  INVALID_INPUT: 'invalid_input',
});

const DEFAULT_MAX_OPERATIONS = 10_000;
const DEFAULT_MAX_CANDIDATES = 256;
const DEFAULT_MAX_MISSING_PREMISES = 8;
const DEFAULT_TIMEOUT_MS = 100;

function factKey(fact) {
  return JSON.stringify([fact.predicate, ...fact.args.map((term) => term.value)]);
}

function groundFact(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.args)) {
    throw new TypeError('ground fact is required');
  }
  return atom(input.predicate, input.args.map((term) => {
    if (!term || term.kind !== 'constant') {
      throw new TypeError('abduction facts must be ground');
    }
    return constant(term.value);
  }));
}

function strings(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
    return value.trim();
  }))].sort();
}

function normalizeEvidence(input) {
  if (!Array.isArray(input)) throw new TypeError('evidence must be an array');
  const byKey = new Map();
  for (const item of input) {
    if (!item || typeof item !== 'object' || !item.fact) {
      throw new TypeError('evidence item must contain fact');
    }
    const fact = groundFact(item.fact);
    const provenanceRefs = strings(item.provenanceRefs, 'evidence.provenanceRefs');
    const sourceRefs = strings(item.sourceRefs, 'evidence.sourceRefs');
    if (provenanceRefs.length === 0 && sourceRefs.length === 0) {
      throw new TypeError('observed evidence requires provenance or source refs');
    }
    const key = factKey(fact);
    byKey.set(key, Object.freeze({
      fact,
      factKey: key,
      provenanceRefs: Object.freeze(provenanceRefs),
      sourceRefs: Object.freeze(sourceRefs),
      hard: item.hard !== false,
    }));
  }
  return [...byKey.values()].sort((a, b) => a.factKey.localeCompare(b.factKey));
}

function normalizeRules(input) {
  if (!Array.isArray(input)) throw new TypeError('rules must be an array');
  return input
    .map((rule) => parseRule(serializeRule(rule)))
    .sort((left, right) => {
      const byId = left.id.localeCompare(right.id);
      if (byId !== 0) return byId;
      return serializeRule(left).localeCompare(serializeRule(right));
    });
}

function normalizeSeeds(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError('seedCandidates must be an array');
  return input.map((seed) => {
    if (!seed || typeof seed !== 'object' || !seed.fact) {
      throw new TypeError('seed candidate must contain fact');
    }
    const fact = groundFact(seed.fact);
    const kind = typeof seed.kind === 'string' && seed.kind.trim()
      ? seed.kind.trim()
      : 'hypothesis-seed';
    const source = typeof seed.source === 'string' && seed.source.trim()
      ? seed.source.trim()
      : 'external';
    const evidenceSemantics = kind === 'co-occurrence-similarity'
      ? 'co_occurrence_not_semantic'
      : (typeof seed.evidenceSemantics === 'string' && seed.evidenceSemantics.trim()
        ? seed.evidenceSemantics.trim()
        : 'hypothesis_seed_only');
    return Object.freeze({
      fact,
      factKey: factKey(fact),
      kind,
      source,
      evidenceSemantics,
    });
  }).sort((a, b) => {
    const byFact = a.factKey.localeCompare(b.factKey);
    if (byFact !== 0) return byFact;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return a.source.localeCompare(b.source);
  });
}

function normalizeLimits(opts = {}) {
  const maxOperations = opts.maxOperations === undefined
    ? DEFAULT_MAX_OPERATIONS
    : opts.maxOperations;
  const maxCandidates = opts.maxCandidates === undefined
    ? DEFAULT_MAX_CANDIDATES
    : opts.maxCandidates;
  const maxMissingPremises = opts.maxMissingPremises === undefined
    ? DEFAULT_MAX_MISSING_PREMISES
    : opts.maxMissingPremises;
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  if (!Number.isInteger(maxOperations) || maxOperations <= 0) return null;
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) return null;
  if (!Number.isInteger(maxMissingPremises) || maxMissingPremises < 0) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return { maxOperations, maxCandidates, maxMissingPremises, timeoutMs };
}

function applyBindings(input, bindings) {
  const map = new Map(bindings.map((entry) => [entry.variable, entry.value]));
  return atom(input.predicate, input.args.map((term) => {
    if (term.kind === 'constant') return term;
    return map.has(term.name) ? constant(map.get(term.name)) : term;
  }));
}

function isGround(input) {
  return input.args.every((term) => term.kind === 'constant');
}

function supportSet(candidate) {
  return new Set([
    ...candidate.observedSupports.map((item) => item.factKey),
    ...candidate.missingPremises.map((item) => item.factKey),
  ]);
}

function strictSubset(left, right) {
  if (left.size >= right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

function minimizeCandidates(candidates) {
  return candidates.filter((candidate, index) => {
    const set = supportSet(candidate);
    return !candidates.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      if (other.missingPremises.length > candidate.missingPremises.length) return false;
      return strictSubset(supportSet(other), set);
    });
  });
}

function explanationId(candidate) {
  const payload = JSON.stringify({
    observation: factKey(candidate.observation),
    ruleId: candidate.ruleId,
    observed: candidate.observedSupports.map((item) => item.factKey),
    missing: candidate.missingPremises.map((item) => item.factKey),
  });
  return `abd_${crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32)}`;
}

function freezeCandidate(candidate) {
  const observedSupports = [...candidate.observedSupports]
    .sort((a, b) => a.factKey.localeCompare(b.factKey));
  const missingPremises = [...candidate.missingPremises]
    .sort((a, b) => a.factKey.localeCompare(b.factKey));
  const base = {
    state: 'provisional',
    observation: candidate.observation,
    ruleId: candidate.ruleId,
    observedSupports: Object.freeze(observedSupports),
    missingPremises: Object.freeze(missingPremises),
  };
  return Object.freeze({
    explanationId: explanationId(base),
    ...base,
    belief: Object.freeze({
      value: null,
      semantics: 'abduction_proposal_not_belief',
    }),
  });
}

function compareCandidates(left, right) {
  const byMissing = left.missingPremises.length - right.missingPremises.length;
  if (byMissing !== 0) return byMissing;
  const leftTotal = left.observedSupports.length + left.missingPremises.length;
  const rightTotal = right.observedSupports.length + right.missingPremises.length;
  if (leftTotal !== rightTotal) return leftTotal - rightTotal;
  const byRule = left.ruleId.localeCompare(right.ruleId);
  if (byRule !== 0) return byRule;
  return left.explanationId.localeCompare(right.explanationId);
}

module.exports = {
  ABDUCTION_STATUS,
  ABDUCTION_STOPPED,
  factKey,
  groundFact,
  normalizeEvidence,
  normalizeRules,
  normalizeSeeds,
  normalizeLimits,
  applyBindings,
  isGround,
  minimizeCandidates,
  freezeCandidate,
  compareCandidates,
};
