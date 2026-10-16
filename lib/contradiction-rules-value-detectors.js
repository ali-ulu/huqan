// #2178: detectors for conflicting values -- numerical, value, type,
// cause-versus-prevent and predicate drift.

const { normalizeText } = require('./text-utils');
const { detectRelationDrift } = require('./relation-drift');
const { detectSemanticOpposition, hasNegationTopicOverlap } = require('./contradiction-rules-opposition-detectors');
const { collectSignal, extractComparableNumbers, extractTextParts, hasAnyPhrase, hasAnyToken, sameSubject } = require('./contradiction-rules-text');
const { CAUSE_FAMILY, CONTRADICTION_RULES, NEGATION_TOKENS, PREVENT_FAMILY, TYPE_DISJOINTS } = require('./contradiction-rules-vocabulary');

function detectNumericalConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedNums = extractComparableNumbers(parts.storedText, parts.storedSubject || stored.subject || stored.from || stored.entity || stored.node || stored.target);
  const incomingNums = extractComparableNumbers(parts.incomingText, parts.incomingSubject || incoming.subject || incoming.from || incoming.entity || incoming.node || incoming.target);
  if (storedNums.length === 0 || incomingNums.length === 0) return null;

  const storedSet = new Set(storedNums.map(String));
  const incomingSet = new Set(incomingNums.map(String));
  const overlap = [...storedSet].some(value => incomingSet.has(value));
  if (overlap) return null;

  return collectSignal(
    CONTRADICTION_RULES.NUMERICAL_CONFLICT,
    'Different numeric values detected for the same subject/predicate.',
    [
      { text: parts.storedText, role: 'stored' },
      { text: parts.incomingText, role: 'incoming' },
    ],
    {
      severity: 0.9,
      confidence: 0.95,
      flags: ['NUMERICAL_CONFLICT', 'VALUE_CONFLICT'],
      meta: {
        storedNumbers: storedNums,
        incomingNumbers: incomingNums,
      },
    }
  );
}

function detectValueConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const valueVerbs = ['is in', 'located in', 'means', 'means that', 'was in', 'is located in'];
  const storedText = parts.storedText;
  const incomingText = parts.incomingText;
  const storedHasVerb = valueVerbs.some(verb => storedText.includes(verb));
  const incomingHasVerb = valueVerbs.some(verb => incomingText.includes(verb));
  if (!storedHasVerb || !incomingHasVerb) return null;

  const storedObject = parts.storedObject || storedText.split(/\bis in\b|\blocated in\b|\bmeans\b|\bwas in\b/i).pop().trim();
  const incomingObject = parts.incomingObject || incomingText.split(/\bis in\b|\blocated in\b|\bmeans\b|\bwas in\b/i).pop().trim();
  if (!storedObject || !incomingObject) return null;
  if (normalizeText(storedObject) === normalizeText(incomingObject)) return null;
  if (storedObject.length < 2 || incomingObject.length < 2) return null;

  return collectSignal(
    CONTRADICTION_RULES.VALUE_CONFLICT,
    'Same subject maps to different values in a stable value slot.',
    [
      { text: storedText, role: 'stored' },
      { text: incomingText, role: 'incoming' },
    ],
      {
        severity: 0.8,
        confidence: 0.9,
        flags: ['VALUE_CONFLICT', 'LOCATION_CONFLICT'],
        meta: {
        storedValue: storedObject,
        incomingValue: incomingObject,
        },
      }
  );
}

function detectTypeConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedObj = parts.storedObject || parts.storedText;
  const incomingObj = parts.incomingObject || parts.incomingText;
  if (!storedObj || !incomingObj) return null;

  const found = TYPE_DISJOINTS.find(([a, b]) => {
    const x = normalizeText(a);
    const y = normalizeText(b);
    const storedNorm = normalizeText(storedObj);
    const incomingNorm = normalizeText(incomingObj);
    return (storedNorm.includes(x) && incomingNorm.includes(y)) || (storedNorm.includes(y) && incomingNorm.includes(x));
  });

  if (!found) return null;

  return collectSignal(
    CONTRADICTION_RULES.TYPE_CONFLICT,
    'Known disjoint type pair detected for the same subject.',
    [
      { text: parts.storedText, role: 'stored' },
      { text: parts.incomingText, role: 'incoming' },
    ],
    {
      severity: 0.9,
      confidence: 0.95,
      flags: ['TYPE_CONFLICT'],
      meta: {
        pair: found,
      },
    }
  );
}

function detectCausePreventOpposition(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedText = parts.storedText;
  const incomingText = parts.incomingText;
  const storedRelation = parts.storedRelation;
  const incomingRelation = parts.incomingRelation;

  const storedIsCause = hasAnyPhrase(storedText, CAUSE_FAMILY) || hasAnyPhrase(storedRelation, CAUSE_FAMILY);
  const storedIsPrevent = hasAnyPhrase(storedText, PREVENT_FAMILY) || hasAnyPhrase(storedRelation, PREVENT_FAMILY);
  const incomingIsCause = hasAnyPhrase(incomingText, CAUSE_FAMILY) || hasAnyPhrase(incomingRelation, CAUSE_FAMILY);
  const incomingIsPrevent = hasAnyPhrase(incomingText, PREVENT_FAMILY) || hasAnyPhrase(incomingRelation, PREVENT_FAMILY);

  const opposed = (storedIsCause && incomingIsPrevent) || (storedIsPrevent && incomingIsCause);
  if (!opposed) return null;

  return collectSignal(
    CONTRADICTION_RULES.CAUSE_PREVENT_OPPOSITION,
    'Deterministic cause/prevent opposition detected for the same subject.',
    [
      { text: storedText, role: 'stored' },
      { text: incomingText, role: 'incoming' },
    ],
    {
      severity: 0.9,
      confidence: 0.95,
      flags: [CONTRADICTION_RULES.CAUSE_PREVENT_OPPOSITION, CONTRADICTION_RULES.SEMANTIC_OPPOSITION, 'SEMANTIC_OPPOSITION'],
      meta: {
        storedRelation,
        incomingRelation,
        oppositionFamily: 'cause_prevent',
      },
    }
  );
}

function detectPredicateDrift(stored, incoming, opts = {}) {
  const drift = detectRelationDrift(stored, incoming, opts);
  if (!drift) return null;

  const opposition = detectSemanticOpposition(stored, incoming, opts);
  const causePreventOpposition = detectCausePreventOpposition(stored, incoming, opts);
  if (opposition || causePreventOpposition) return null;

  // A negated incoming claim with no topical overlap with the stored fact is
  // an unrelated negative statement, not a drifted/contradicting predicate.
  const parts = extractTextParts(stored, incoming);
  const incomingNeg = hasAnyToken(parts.incomingText, NEGATION_TOKENS);
  if (incomingNeg && !hasNegationTopicOverlap(parts)) return null;

  return drift;
}

module.exports = {
  detectCausePreventOpposition,
  detectNumericalConflict,
  detectPredicateDrift,
  detectTypeConflict,
  detectValueConflict,
};
