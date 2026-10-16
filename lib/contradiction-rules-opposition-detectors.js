// #2178: detectors for opposed statements -- negation, units, relation
// inversion and semantic opposition.

const { normalizeText, tokenize } = require('./text-utils');
const { asText, collectSignal, extractTextParts, hasAnyToken, sameSubject, stripSubject } = require('./contradiction-rules-text');
const { CONTRADICTION_RULES, NEGATION_TOKENS, OPPOSITION_PAIRS } = require('./contradiction-rules-vocabulary');

const NEGATION_OVERLAP_STOPWORDS = new Set([
  ...NEGATION_TOKENS.map(token => asText(token)),
  'bir', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'have', 'has', 'do', 'does', 'did',
]);

function negationOverlapTokens(text, subject) {
  return tokenize(stripSubject(text, subject)).filter(token => (token.length > 1 || /^\d+$/.test(token)) && !NEGATION_OVERLAP_STOPWORDS.has(token));
}

function hasNegationTopicOverlap(parts) {
  const storedTokens = new Set(negationOverlapTokens(parts.storedText, parts.storedSubject));
  const incomingTokens = new Set(negationOverlapTokens(parts.incomingText, parts.incomingSubject));
  for (const token of storedTokens) {
    if (incomingTokens.has(token)) return true;
  }
  return false;
}

function detectNegationConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedNeg = hasAnyToken(parts.storedText, NEGATION_TOKENS);
  const incomingNeg = hasAnyToken(parts.incomingText, NEGATION_TOKENS);
  if (storedNeg === incomingNeg) return null;

  // Negation alone is not enough: the negated claim must actually be about
  // the same predicate/object as the stored fact, otherwise an unrelated
  // negative statement about the subject is wrongly flagged as a conflict.
  if (!hasNegationTopicOverlap(parts)) return null;

  return collectSignal(
    CONTRADICTION_RULES.NEGATION_CONFLICT,
    'One claim is negated while the other is affirmative.',
    [
      { text: parts.storedText, role: 'stored' },
      { text: parts.incomingText, role: 'incoming' },
    ],
    {
      severity: 0.85,
      confidence: 0.9,
      flags: [CONTRADICTION_RULES.NEGATION_CONFLICT, 'SEMANTIC_OPPOSITION'],
      meta: {
        storedNeg,
        incomingNeg,
      },
    }
  );
}

function detectUnitConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedUnits = ['celsius', 'fahrenheit', 'kelvin', 'feet', 'meter', 'metre', 'knots', 'knot', 'kg', 'km'];
  const incomingUnits = storedUnits;
  const storedHasUnit = storedUnits.find(unit => asText(parts.storedText).includes(unit));
  const incomingHasUnit = incomingUnits.find(unit => asText(parts.incomingText).includes(unit));
  if (!storedHasUnit || !incomingHasUnit) return null;

  const storedNums = parts.storedText.match(/-?\d+(?:[.,]\d+)?/g) || [];
  const incomingNums = parts.incomingText.match(/-?\d+(?:[.,]\d+)?/g) || [];
  if (storedNums.length === 0 || incomingNums.length === 0) return null;

  // Normalize spelling variants to a canonical form before comparing units.
  // "meter" (US) and "metre" (UK/TR) are the same unit; without this, a stored
  // "10 meter" and an incoming "10 metre" would be flagged as a unit conflict.
  const canonicalUnit = (unit) => unit === 'meter' ? 'metre' : unit;
  const storedCanonical = canonicalUnit(storedHasUnit);
  const incomingCanonical = canonicalUnit(incomingHasUnit);

  if (storedCanonical !== incomingCanonical || storedNums.join(',') !== incomingNums.join(',')) {
    return collectSignal(
      CONTRADICTION_RULES.UNIT_CONFLICT,
      'Same measured slot has different unit or value.',
      [
        { text: parts.storedText, role: 'stored' },
        { text: parts.incomingText, role: 'incoming' },
      ],
      {
        severity: 0.85,
        confidence: 0.9,
        flags: [CONTRADICTION_RULES.UNIT_CONFLICT],
        meta: {
          storedUnits: storedHasUnit,
          incomingUnits: incomingHasUnit,
        },
      }
    );
  }

  return null;
}

function detectRelationInversion(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const opposition = detectSemanticOpposition(parts.storedText, parts.incomingText, opts);
  if (!opposition) return null;

  return {
    ...opposition,
    rule: CONTRADICTION_RULES.RELATION_INVERSION,
    flags: [...new Set([CONTRADICTION_RULES.RELATION_INVERSION, ...(opposition.flags || [])])],
    meta: {
      ...(opposition.meta || {}),
      relationPair: [parts.storedRelation || '', parts.incomingRelation || ''],
    },
  };
}

function detectSemanticOpposition(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  const storedText = parts.storedText;
  const incomingText = parts.incomingText;
  const pairs = opts.oppositionPairs || OPPOSITION_PAIRS;

  for (const [left, right] of pairs) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    const storedHasA = storedText.includes(a);
    const storedHasB = storedText.includes(b);
    const incomingHasA = incomingText.includes(a);
    const incomingHasB = incomingText.includes(b);

    if ((storedHasA && incomingHasB) || (storedHasB && incomingHasA)) {
      return collectSignal(
        CONTRADICTION_RULES.SEMANTIC_OPPOSITION,
        'Known opposition pair detected.',
        [
          { text: storedText, role: 'stored' },
          { text: incomingText, role: 'incoming' },
        ],
        {
          severity: 0.9,
          confidence: 0.95,
          flags: [CONTRADICTION_RULES.SEMANTIC_OPPOSITION, 'SEMANTIC_OPPOSITION'],
          meta: {
            pair: [left, right],
          },
        }
      );
    }
  }

  return null;
}

module.exports = {
  detectNegationConflict,
  detectRelationInversion,
  detectSemanticOpposition,
  detectUnitConflict,
  hasNegationTopicOverlap,
};
