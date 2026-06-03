const { hasMeaningfulOverlap, normalizeText, tokenize } = require('./text-utils');
const { detectRelationDrift } = require('./relation-drift');

const CONTRADICTION_RULES = Object.freeze({
  NUMERICAL_CONFLICT: 'NUMERICAL_CONFLICT',
  VALUE_CONFLICT: 'VALUE_CONFLICT',
  TYPE_CONFLICT: 'TYPE_CONFLICT',
  NEGATION_CONFLICT: 'NEGATION_CONFLICT',
  PREDICATE_DRIFT: 'PREDICATE_DRIFT',
  UNIT_CONFLICT: 'UNIT_CONFLICT',
  RELATION_INVERSION: 'RELATION_INVERSION',
  SEMANTIC_OPPOSITION: 'SEMANTIC_OPPOSITION',
});

const NEGATION_TOKENS = [
  'not',
  "isn't",
  "aren't",
  "wasn't",
  'cannot',
  "can't",
  'no',
  'never',
  'değil',
  'değildir',
  'yok',
  'yoktur',
  'olmaz',
  'asla',
  'hiçbir',
];

const TYPE_DISJOINTS = Object.freeze([
  ['jet aircraft', 'piston aircraft'],
  ['regional aircraft', 'widebody aircraft'],
  ['transport category', 'normal category'],
  ['traffic detection', 'weather radar'],
  ['decision speed', 'rotation speed'],
  ['distress call', 'urgency call'],
  ['Mayday', 'Pan-Pan'],
  ['inceltici', 'pıhtılaştırıcı'],
]);

const OPPOSITION_PAIRS = Object.freeze([
  ['inceltici', 'pıhtılaştırıcı'],
  ['artırır', 'azaltır'],
  ['güvenli', 'riskli'],
  ['izinli', 'yasak'],
  ['doğru', 'yanlış'],
  ['distress call', 'urgency call'],
  ['mayday', 'pan-pan'],
  ['decision speed', 'rotation speed'],
  ['traffic detection', 'weather radar'],
  ['piston aircraft', 'jet aircraft'],
  ['regional aircraft', 'widebody aircraft'],
  ['transport category', 'normal category'],
]);

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function asText(value) {
  return normalizeText(value);
}

function textTokens(value) {
  return asText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function hasAnyToken(text, tokens) {
  const haystack = ` ${asText(text)} `;
  return tokens.some(token => haystack.includes(` ${asText(token)} `) || haystack.includes(asText(token)));
}

function collectSignal(rule, detail, evidence, opts = {}) {
  return {
    rule,
    kind: 'contradiction',
    severity: clamp01(opts.severity ?? 0.8, 0.8),
    confidence: clamp01(opts.confidence ?? 0.9, 0.9),
    flags: Array.isArray(opts.flags) ? [...new Set([rule, ...opts.flags])] : [rule],
    detail,
    evidence: Array.isArray(evidence) ? evidence : [],
    meta: {
      ...((opts.meta && typeof opts.meta === 'object') ? opts.meta : {}),
    },
  };
}

function extractTextParts(stored, incoming) {
  return {
    storedText: asText(stored?.text || stored?.statement || stored?.claim || stored || ''),
    incomingText: asText(incoming?.text || incoming?.statement || incoming?.claim || incoming || ''),
    storedSubject: asText(stored?.subject || stored?.from || stored?.entity || stored?.node || stored?.target || ''),
    incomingSubject: asText(incoming?.subject || incoming?.from || incoming?.entity || incoming?.node || incoming?.target || ''),
    storedObject: asText(stored?.object || stored?.to || stored?.value || stored?.predicate || ''),
    incomingObject: asText(incoming?.object || incoming?.to || incoming?.value || incoming?.predicate || ''),
    storedRelation: asText(stored?.relation || stored?.verb || stored?.predicate || ''),
    incomingRelation: asText(incoming?.relation || incoming?.verb || incoming?.predicate || ''),
  };
}

function stripSubject(text, subject) {
  const rawText = asText(text);
  const rawSubject = asText(subject);
  if (!rawText || !rawSubject) return rawText;
  return rawText.replace(new RegExp(`\\b${rawSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function extractComparableNumbers(text, subject) {
  const stripped = stripSubject(text, subject);
  return stripped.match(/-?\d+(?:[.,]\d+)?/g) || [];
}

function sameSubject(stored, incoming) {
  const parts = extractTextParts(stored, incoming);
  if (parts.storedSubject && parts.incomingSubject) {
    return parts.storedSubject === parts.incomingSubject;
  }
  const storedText = parts.storedText;
  const incomingText = parts.incomingText;
  const firstStored = storedText.split(' ')[0];
  const firstIncoming = incomingText.split(' ')[0];
  return Boolean(firstStored && firstIncoming && firstStored === firstIncoming);
}

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

function detectPredicateDrift(stored, incoming, opts = {}) {
  const drift = detectRelationDrift(stored, incoming, opts);
  if (!drift) return null;

  const opposition = detectSemanticOpposition(stored, incoming, opts);
  if (opposition) return null;

  return drift;
}

function detectNegationConflict(stored, incoming, opts = {}) {
  const parts = extractTextParts(stored, incoming);
  if (!sameSubject(stored, incoming)) return null;

  const storedNeg = hasAnyToken(parts.storedText, NEGATION_TOKENS);
  const incomingNeg = hasAnyToken(parts.incomingText, NEGATION_TOKENS);
  if (storedNeg === incomingNeg) return null;

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
  if (storedHasUnit !== incomingHasUnit || storedNums.join(',') !== incomingNums.join(',')) {
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

function runContradictionRules(stored, incoming, opts = {}) {
  const rules = [
    detectNumericalConflict(stored, incoming, opts),
    detectValueConflict(stored, incoming, opts),
    detectTypeConflict(stored, incoming, opts),
    detectNegationConflict(stored, incoming, opts),
    detectUnitConflict(stored, incoming, opts),
    detectSemanticOpposition(stored, incoming, opts),
    detectRelationInversion(stored, incoming, opts),
    detectPredicateDrift(stored, incoming, opts),
  ];

  return rules.filter(Boolean);
}

module.exports = {
  CONTRADICTION_RULES,
  NEGATION_TOKENS,
  OPPOSITION_PAIRS,
  TYPE_DISJOINTS,
  detectNumericalConflict,
  detectValueConflict,
  detectTypeConflict,
  detectPredicateDrift,
  detectNegationConflict,
  detectUnitConflict,
  detectRelationInversion,
  detectSemanticOpposition,
  runContradictionRules,
};
