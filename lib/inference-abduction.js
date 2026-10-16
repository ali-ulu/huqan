'use strict';

const { UNIFICATION_STATUS, unifyAtom } = require('./inference-unification');
const {
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
} = require('./inference-abduction-values');

function buildResult(state, status, stoppedReason) {
  const dedup = new Map();
  for (const raw of state.candidates) {
    const frozen = freezeCandidate(raw);
    dedup.set(frozen.explanationId, frozen);
  }
  const all = [...dedup.values()];
  const minimal = minimizeCandidates(all).sort(compareCandidates);
  return Object.freeze({
    status,
    stoppedReason,
    candidates: Object.freeze(minimal),
    stats: Object.freeze({
      operations: state.operations,
      generatedCandidates: all.length,
      minimalCandidates: minimal.length,
      dominatedCandidates: all.length - minimal.length,
      conflictingPremisesRejected: state.conflictingPremisesRejected,
      unresolvedBranches: state.unresolvedBranches,
      constraintUnknowns: state.constraintUnknowns,
      dreamSeedsUsed: state.dreamSeedsUsed,
    }),
  });
}

function checkBudget(state) {
  if (state.operations >= state.maxOperations) return ABDUCTION_STOPPED.MAX_OPERATIONS;
  if (state.candidates.length >= state.maxCandidates) return ABDUCTION_STOPPED.MAX_CANDIDATES;
  if (state.now() - state.startedAt > state.timeoutMs) return ABDUCTION_STOPPED.TIMEOUT;
  return '';
}

function noteOperation(state) {
  const stopped = checkBudget(state);
  if (stopped) return stopped;
  state.operations += 1;
  return '';
}

function hardConflict(fact, state, opts) {
  if (typeof opts.conflictEvaluator !== 'function') return { conflict: false, stopped: '' };
  const stopped = noteOperation(state);
  if (stopped) return { conflict: false, stopped };

  let result;
  try {
    result = opts.conflictEvaluator(fact);
  } catch (_) {
    state.unresolvedBranches += 1;
    return { conflict: true, stopped: '' };
  }
  if (result === true) return { conflict: true, stopped: '' };
  if (result && typeof result === 'object' && result.conflict === true) {
    return { conflict: result.hard !== false, stopped: '' };
  }
  return { conflict: false, stopped: '' };
}

function evaluateConstraints(rule, bindings, state, opts) {
  if (rule.constraints.length === 0) return { allowed: true, stopped: '' };
  if (typeof opts.constraintEvaluator !== 'function') {
    state.constraintUnknowns += 1;
    return { allowed: false, stopped: '' };
  }

  for (const constraint of rule.constraints) {
    const stopped = noteOperation(state);
    if (stopped) return { allowed: false, stopped };
    const ground = applyBindings(constraint, bindings);
    if (!isGround(ground)) {
      state.constraintUnknowns += 1;
      return { allowed: false, stopped: '' };
    }

    let verdict;
    try {
      verdict = opts.constraintEvaluator(ground);
    } catch (_) {
      verdict = 'unknown';
    }
    if (verdict !== true) {
      if (verdict !== false) state.constraintUnknowns += 1;
      return { allowed: false, stopped: '' };
    }
  }
  return { allowed: true, stopped: '' };
}

function seedMatches(pattern, bindings, seeds, state) {
  const matches = [];
  for (const seed of seeds) {
    if (seed.fact.predicate !== pattern.predicate) continue;
    const stopped = noteOperation(state);
    if (stopped) return { matches, stopped };
    const match = unifyAtom(pattern, seed.fact, { bindings });
    if (match.status === UNIFICATION_STATUS.MATCH) {
      matches.push({ seed, bindings: match.bindings });
    }
  }
  return { matches, stopped: '' };
}

function evidenceMatches(pattern, bindings, evidence, state) {
  const matches = [];
  for (const item of evidence) {
    if (item.fact.predicate !== pattern.predicate) continue;
    const stopped = noteOperation(state);
    if (stopped) return { matches, stopped };
    const match = unifyAtom(pattern, item.fact, { bindings });
    if (match.status === UNIFICATION_STATUS.MATCH) {
      matches.push({ item, bindings: match.bindings });
    }
  }
  return { matches, stopped: '' };
}

function solveBody(rule, index, branch, ctx) {
  const stopped = checkBudget(ctx.state);
  if (stopped) return stopped;

  if (index >= rule.body.length) {
    const constraint = evaluateConstraints(rule, branch.bindings, ctx.state, ctx.opts);
    if (constraint.stopped) return constraint.stopped;
    if (!constraint.allowed) return '';

    ctx.state.candidates.push({
      observation: ctx.observation,
      ruleId: rule.id,
      observedSupports: branch.observedSupports,
      missingPremises: branch.missingPremises,
    });
    return checkBudget(ctx.state);
  }

  const pattern = rule.body[index];
  const observed = evidenceMatches(
    pattern,
    branch.bindings,
    ctx.evidence,
    ctx.state,
  );
  if (observed.stopped) return observed.stopped;

  if (observed.matches.length > 0) {
    for (const match of observed.matches) {
      const nextObserved = [...branch.observedSupports];
      if (!nextObserved.some((item) => item.factKey === match.item.factKey)) {
        nextObserved.push(match.item);
      }
      const result = solveBody(rule, index + 1, {
        bindings: match.bindings,
        observedSupports: nextObserved,
        missingPremises: branch.missingPremises,
      }, ctx);
      if (result) return result;
    }
    return '';
  }

  const seeded = seedMatches(pattern, branch.bindings, ctx.seeds, ctx.state);
  if (seeded.stopped) return seeded.stopped;

  if (seeded.matches.length > 0) {
    for (const match of seeded.matches) {
      if (branch.missingPremises.length >= ctx.state.maxMissingPremises) {
        return ABDUCTION_STOPPED.MAX_MISSING_PREMISES;
      }
      const conflict = hardConflict(match.seed.fact, ctx.state, ctx.opts);
      if (conflict.stopped) return conflict.stopped;
      if (conflict.conflict) {
        ctx.state.conflictingPremisesRejected += 1;
        continue;
      }
      ctx.state.dreamSeedsUsed += match.seed.source === 'dream' ? 1 : 0;
      const result = solveBody(rule, index + 1, {
        bindings: match.bindings,
        observedSupports: branch.observedSupports,
        missingPremises: [...branch.missingPremises, Object.freeze({
          fact: match.seed.fact,
          factKey: match.seed.factKey,
          seed: match.seed,
        })],
      }, ctx);
      if (result) return result;
    }
    return '';
  }

  const missing = applyBindings(pattern, branch.bindings);
  if (!isGround(missing)) {
    ctx.state.unresolvedBranches += 1;
    return '';
  }
  if (branch.missingPremises.length >= ctx.state.maxMissingPremises) {
    return ABDUCTION_STOPPED.MAX_MISSING_PREMISES;
  }

  const conflict = hardConflict(missing, ctx.state, ctx.opts);
  if (conflict.stopped) return conflict.stopped;
  if (conflict.conflict) {
    ctx.state.conflictingPremisesRejected += 1;
    return '';
  }

  return solveBody(rule, index + 1, {
    bindings: branch.bindings,
    observedSupports: branch.observedSupports,
    missingPremises: [...branch.missingPremises, Object.freeze({
      fact: missing,
      factKey: factKey(missing),
      seed: null,
    })],
  }, ctx);
}

function abduct(observationInput, rulesInput, evidenceInput, opts = {}) {
  const limits = normalizeLimits(opts);
  if (!limits) {
    return Object.freeze({
      status: ABDUCTION_STATUS.INVALID,
      stoppedReason: ABDUCTION_STOPPED.INVALID_INPUT,
      candidates: Object.freeze([]),
      stats: Object.freeze({
        operations: 0,
        generatedCandidates: 0,
        minimalCandidates: 0,
        dominatedCandidates: 0,
        conflictingPremisesRejected: 0,
        unresolvedBranches: 0,
        constraintUnknowns: 0,
        dreamSeedsUsed: 0,
      }),
    });
  }

  let observation;
  let rules;
  let evidence;
  let seeds;
  try {
    observation = groundFact(observationInput);
    rules = normalizeRules(rulesInput);
    evidence = normalizeEvidence(evidenceInput);
    seeds = normalizeSeeds(opts.seedCandidates);
  } catch (_) {
    return Object.freeze({
      status: ABDUCTION_STATUS.INVALID,
      stoppedReason: ABDUCTION_STOPPED.INVALID_INPUT,
      candidates: Object.freeze([]),
      stats: Object.freeze({
        operations: 0,
        generatedCandidates: 0,
        minimalCandidates: 0,
        dominatedCandidates: 0,
        conflictingPremisesRejected: 0,
        unresolvedBranches: 0,
        constraintUnknowns: 0,
        dreamSeedsUsed: 0,
      }),
    });
  }

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const state = {
    ...limits,
    now,
    startedAt: now(),
    operations: 0,
    candidates: [],
    conflictingPremisesRejected: 0,
    unresolvedBranches: 0,
    constraintUnknowns: 0,
    dreamSeedsUsed: 0,
  };
  const ctx = { observation, evidence, seeds, opts, state };

  let stoppedReason = '';
  for (const rule of rules) {
    if (rule.head.predicate !== observation.predicate) continue;
    const stopped = noteOperation(state);
    if (stopped) {
      stoppedReason = stopped;
      break;
    }

    const head = unifyAtom(rule.head, observation);
    if (head.status !== UNIFICATION_STATUS.MATCH) continue;

    stoppedReason = solveBody(rule, 0, {
      bindings: head.bindings,
      observedSupports: [],
      missingPremises: [],
    }, ctx);
    if (stoppedReason) break;
  }

  return buildResult(
    state,
    stoppedReason ? ABDUCTION_STATUS.STOPPED : ABDUCTION_STATUS.COMPLETE,
    stoppedReason || ABDUCTION_STOPPED.FIXPOINT,
  );
}

module.exports = {
  ABDUCTION_STATUS,
  ABDUCTION_STOPPED,
  abduct,
};
