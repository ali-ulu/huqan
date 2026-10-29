'use strict';

const { AUTHORITY, clamp01, round6, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-dual-process-v1';

// Frozen in the G2 preregistration (docs/task-packs/cog-m5-g2-preregistration-*.md).
const WEIGHTS = Object.freeze({ predictionError: 0.35, uncertainty: 0.25, novelty: 0.20, arousal: 0.20 });
const S1_MAX_DEMAND = 0.30;
const S2_MIN_DEMAND = 0.60;

const MODES = Object.freeze({ SYSTEM1: 'SYSTEM1', SYSTEM1_VERIFY: 'SYSTEM1_VERIFY', SYSTEM2: 'SYSTEM2' });

// riskLevel arrives uppercase from classifyAgentAction (lib/risk-policy-constants.js)
// and lowercase from the plan/cognitive-scheduler vocabulary. Unknown or missing risk
// is treated as deliberation-worthy, never as low.
const RISK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

const TRUST_VERIFY = new Set(['probationary']);
const TRUST_DELIBERATE = new Set(['insufficient-data']);

const text = (value) => typeof value === 'string' && value.trim() !== '';
const fraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

function normalizeRisk(riskLevel) {
  if (!text(riskLevel)) return null;
  const key = riskLevel.trim().toLowerCase();
  return Object.hasOwn(RISK, key) ? key : null;
}

// Every component is clamped to [0,1]; a missing or malformed component counts as 1
// (maximal demand), so uncertainty pushes toward deliberation and never away from it.
function demandComponents({ predictionError, value, novelty, arousal }) {
  const recentMean = isPlainObject(predictionError) ? fraction(predictionError.recentMean) : null;
  const supportScore = isPlainObject(value) ? fraction(value.supportScore) : null;
  const raw = {
    predictionError: recentMean,
    uncertainty: supportScore === null ? null : 1 - supportScore,
    novelty: fraction(novelty),
    arousal: fraction(arousal),
  };
  const unknownComponents = Object.keys(raw).filter((key) => raw[key] === null);
  const components = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value === null ? 1 : round6(clamp01(value))]));
  const demand = round6(clamp01(Object.keys(WEIGHTS).reduce((sum, key) => sum + WEIGHTS[key] * components[key], 0)));
  return { components, unknownComponents, demand };
}

function adviseMode(input) {
  const emit = (mode, reason, demand, components, unknownComponents, routeRef) => freezeResult({
    schemaVersion: SCHEMA_VERSION, mode, demand, components, unknownComponents,
    reasons: [reason], routeRef, executes: false, authority: AUTHORITY.ROUTING_ADVICE_ONLY,
  });
  if (!isPlainObject(input)) {
    return emit(null, 'invalid_input', null, null, [], Object.freeze({ requestId: null, chosenCapabilityId: null }));
  }
  const route = isPlainObject(input.route) ? input.route : {};
  const routeRef = Object.freeze({
    requestId: text(route.requestId) ? route.requestId : null,
    chosenCapabilityId: text(route.chosenCapabilityId) ? route.chosenCapabilityId : null,
  });
  const trustState = text(route.trustState) ? route.trustState : null;
  const { components, unknownComponents, demand } = demandComponents(input);

  const risk = normalizeRisk(input.riskLevel);
  if (risk === null || RISK[risk] >= RISK.high) return emit(MODES.SYSTEM2, 'risk_requires_deliberation', demand, components, unknownComponents, routeRef);
  if ((route.refusalReason !== undefined && route.refusalReason !== null) || !text(route.chosenCapabilityId)) {
    return emit(MODES.SYSTEM2, 'no_compiled_procedure', demand, components, unknownComponents, routeRef);
  }
  if (trustState !== null && TRUST_DELIBERATE.has(trustState)) return emit(MODES.SYSTEM2, 'trust_insufficient_data', demand, components, unknownComponents, routeRef);
  if (trustState !== null && TRUST_VERIFY.has(trustState)) {
    return demand >= S2_MIN_DEMAND
      ? emit(MODES.SYSTEM2, 'demand_requires_deliberation', demand, components, unknownComponents, routeRef)
      : emit(MODES.SYSTEM1_VERIFY, 'probationary_requires_verification', demand, components, unknownComponents, routeRef);
  }
  if (demand < S1_MAX_DEMAND) return emit(MODES.SYSTEM1, 'low_demand_trusted_procedure', demand, components, unknownComponents, routeRef);
  if (demand < S2_MIN_DEMAND) return emit(MODES.SYSTEM1_VERIFY, 'moderate_demand_verify', demand, components, unknownComponents, routeRef);
  return emit(MODES.SYSTEM2, 'demand_requires_deliberation', demand, components, unknownComponents, routeRef);
}

module.exports = { SCHEMA_VERSION, WEIGHTS, S1_MAX_DEMAND, S2_MIN_DEMAND, MODES, adviseMode };
