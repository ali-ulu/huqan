const { normalizeText } = require('./text-utils');
const { runContradictionRules } = require('./contradiction-rules');
const { runRiskRules } = require('./risk-rules');
const { evaluateSemanticModel } = require('./semantic-model-port');

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeSignal(signal = {}) {
  const kind = signal.kind === 'risk' || signal.kind === 'contradiction' ? signal.kind : 'risk';
  const flags = Array.isArray(signal.flags) ? [...new Set(signal.flags.filter(Boolean))] : [];
  const evidence = Array.isArray(signal.evidence) ? signal.evidence : [];
  const meta = signal.meta && typeof signal.meta === 'object' && !Array.isArray(signal.meta) ? { ...signal.meta } : {};

  return {
    rule: String(signal.rule || 'UNSPECIFIED'),
    kind,
    severity: clamp01(signal.severity, 0),
    confidence: clamp01(signal.confidence, 0),
    flags,
    detail: signal.detail ? String(signal.detail) : '',
    evidence,
    meta,
  };
}

function collectSignals(results = []) {
  const out = [];
  for (const item of Array.isArray(results) ? results : []) {
    if (Array.isArray(item)) {
      out.push(...collectSignals(item));
      continue;
    }
    if (item) out.push(normalizeSignal(item));
  }
  return out;
}

function summarizeSignals(signals = []) {
  const list = collectSignals(signals);
  const contradiction = list.filter(signal => signal.kind === 'contradiction');
  const risk = list.filter(signal => signal.kind === 'risk');
  const severity = list.reduce((max, signal) => Math.max(max, signal.severity || 0), 0);
  const confidence = list.reduce((max, signal) => Math.max(max, signal.confidence || 0), 0);
  const flags = [...new Set(list.flatMap(signal => signal.flags || []))];

  return {
    total: list.length,
    contradictionCount: contradiction.length,
    riskCount: risk.length,
    severity,
    confidence,
    flags,
    hasSignals: list.length > 0,
  };
}

function runSemanticSignals(stored, incoming, opts = {}) {
  const contradictionSignals = runContradictionRules(stored, incoming, opts);
  const riskSignals = runRiskRules({ stored, incoming }, opts);
  const signals = collectSignals([contradictionSignals, riskSignals]);
  const result = {
    signals,
    summary: summarizeSignals(signals),
  };
  // R51 (#3583): the own-weight model answers beside the rules, never inside
  // them -- it is not a signal, so it cannot move summary.confidence. Mode
  // `off` returns exactly the rules-only object.
  const semanticModel = evaluateSemanticModel(stored, incoming, opts.semanticModel);
  return semanticModel ? { ...result, semanticModel } : result;
}

module.exports = {
  collectSignals,
  normalizeSignal,
  normalizeText,
  runSemanticSignals,
  summarizeSignals,
};
