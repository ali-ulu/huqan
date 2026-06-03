const { hasMeaningfulOverlap, normalizeText, tokenize } = require('./text-utils');

const RELATION_DRIFT_RULES = Object.freeze({
  PREDICATE_DRIFT: 'PREDICATE_DRIFT',
  RELATION_DRIFT: 'RELATION_DRIFT',
});

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function sameSubject(stored, incoming) {
  const left = normalizeText(stored?.subject || stored?.from || '');
  const right = normalizeText(incoming?.subject || incoming?.from || '');
  if (!left || !right) return true;
  return left === right;
}

function extractRelations(stored, incoming) {
  return {
    storedRelation: normalizeText(stored?.relation || stored?.predicate || ''),
    incomingRelation: normalizeText(incoming?.relation || incoming?.predicate || ''),
    storedText: normalizeText(stored?.text || ''),
    incomingText: normalizeText(incoming?.text || ''),
  };
}

function detectRelationDrift(stored, incoming, opts = {}) {
  if (!sameSubject(stored, incoming)) return null;

  const parts = extractRelations(stored, incoming);
  const storedTokens = tokenize(parts.storedText);
  const incomingTokens = tokenize(parts.incomingText);
  const overlap = storedTokens.filter(token => incomingTokens.includes(token));
  const relationMismatch = Boolean(parts.storedRelation && parts.incomingRelation && parts.storedRelation !== parts.incomingRelation);
  const meaningfulOverlap = hasMeaningfulOverlap(parts.storedText, parts.incomingText, 2);

  if (!relationMismatch && overlap.length < 2 && !meaningfulOverlap) return null;
  if (parts.storedText === parts.incomingText) return null;

  return {
    rule: RELATION_DRIFT_RULES.PREDICATE_DRIFT,
    kind: 'contradiction',
    severity: clamp01(opts.severity ?? 0.55, 0.55),
    confidence: clamp01(opts.confidence ?? 0.6, 0.6),
    flags: [RELATION_DRIFT_RULES.PREDICATE_DRIFT, 'RELATION_DRIFT'],
    detail: 'Predicate meaning drift detected between stored and incoming claims.',
    evidence: [
      { text: parts.storedText, role: 'stored' },
      { text: parts.incomingText, role: 'incoming' },
    ],
    meta: {
      storedRelation: parts.storedRelation || '',
      incomingRelation: parts.incomingRelation || '',
      relationMismatch,
      overlap,
    },
  };
}

module.exports = {
  RELATION_DRIFT_RULES,
  detectRelationDrift,
};
