/**
 * Guards that keep `contradicted` verdicts falsifiable (#1619).
 *
 * Two defects met here. Verify escalated `unknown` to `contradicted` from any
 * signal `runContradictionRules` returned, ignoring each signal's own `kind`
 * -- so PREDICATE_DRIFT, which declares `kind: 'risk'` and documents itself as
 * "not a refutation", refuted claims at 0.6 confidence. And because the
 * escalation happens after verify has already chosen its evidence list, the
 * verdict shipped with `evidence: []`: a refutation nobody can check.
 *
 * The rules stay the authority on what refutes a claim; this module only
 * enforces that a refutation names the signals it rests on, and downgrades to
 * `unknown` when it cannot.
 */

const CONTRADICTION_KIND = 'contradiction';

function isContradictionSignal(signal) {
  const kind = String(signal?.kind || '').trim().toLowerCase();
  // Signals predating the `kind` field are contradiction signals: every rule
  // in lib/contradiction-rules.js routes through collectSignal, which sets it.
  if (!kind) return true;
  return kind === CONTRADICTION_KIND;
}

/** Split rule output into refuting signals and advisory risk signals. */
function partitionSignalsByKind(signals) {
  const contradictions = [];
  const risks = [];
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal) continue;
    if (isContradictionSignal(signal)) contradictions.push(signal);
    else risks.push(signal);
  }
  return { contradictions, risks };
}

function signalEvidence(signal) {
  const entries = Array.isArray(signal?.evidence) ? signal.evidence : [];
  const text = entries
    .map(item => (typeof item === 'string' ? item : String(item?.text || '')).trim())
    .filter(Boolean)
    .join(' | ');
  const detail = String(signal?.detail || '').trim();
  const body = text || detail;
  if (!body) return null;
  return {
    kind: 'contradiction_signal',
    text: detail && text ? `${detail} (${text})` : body,
    confidence: Math.max(0, Math.min(1, Number(signal?.confidence) || 0)),
    rule: String(signal?.rule || ''),
    nodes: [],
    edges: [],
  };
}

/**
 * Never let a `contradicted` verdict leave verify with an empty evidence list.
 * Prefer the evidence the refuting signals carry; when they carry none, the
 * verdict is unfalsifiable, so answer `unknown` instead.
 */
function enforceEvidencedContradiction(data, evidence, semanticTrust) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (data?.status !== 'contradicted' || list.length > 0) {
    return { data, evidence: list };
  }

  const { contradictions } = partitionSignalsByKind(semanticTrust?.signals);
  const derived = contradictions.map(signalEvidence).filter(Boolean);
  if (derived.length > 0) return { data, evidence: derived };

  return {
    data: { ...data, status: 'unknown', confidence: 0 },
    evidence: list,
  };
}

module.exports = {
  CONTRADICTION_KIND,
  isContradictionSignal,
  partitionSignalsByKind,
  enforceEvidencedContradiction,
};
