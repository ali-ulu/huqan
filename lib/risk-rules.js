const { normalizeText } = require('./text-utils');
const {
  detectAliasNormalization,
  detectDoubleNegation,
  detectStrawmanAttribution,
  detectWeaselWords,
  runAdversarialSignals,
} = require('./adversarial-signals');

const RISK_RULES = Object.freeze({
  WEAK_PARTIAL_MATCH: 'WEAK_PARTIAL_MATCH',
  HIGH_RISK_DOMAIN: 'HIGH_RISK_DOMAIN',
  ABSOLUTE_CLAIM: 'ABSOLUTE_CLAIM',
  SCOPE_EXPANSION: 'SCOPE_EXPANSION',
  RELATION_DRIFT: 'RELATION_DRIFT',
  MULTILINGUAL_AMBIGUITY: 'MULTILINGUAL_AMBIGUITY',
  PROVENANCE_MISSING: 'PROVENANCE_MISSING',
  DOUBLE_NEGATION: 'DOUBLE_NEGATION',
  WEASEL_WORDS: 'WEASEL_WORDS',
  STRAWMAN_ATTRIBUTION: 'STRAWMAN_ATTRIBUTION',
  ALIAS_NORMALIZATION: 'ALIAS_NORMALIZATION',
});

const HIGH_RISK_DOMAINS = Object.freeze({
  medical: [
    'medical', 'medicine', 'aspirin', 'ilaç', 'tedavi', 'hastalık', 'kanser', 'aşı', 'insülin', 'hipertansiyon',
    'kan inceltici', 'kan pıhtılaştırıcı', 'doz', 'semptom',
  ],
  aviation: [
    'B737', 'A380', 'C172', 'EDDF', 'squawk', 'Mayday', 'Pan-Pan', 'TCAS', 'V1', 'VR', 'ISA', 'FAR Part 25',
    'aircraft', 'engine', 'emergency', 'distress', 'urgency', 'decision speed', 'rotation speed', 'transport category', 'normal category',
  ],
  legal: [
    'legal', 'hukuk', 'sözleşme', 'dava', 'kvkk', 'gdpr', 'izin', 'yasak', 'veri', 'mahremiyet', 'ceza',
  ],
  financial: [
    'finance', 'financial', 'bank', 'loan', 'credit', 'faiz', 'borsa', 'yatırım', 'para', 'risk',
  ],
  security: [
    'security', 'güvenlik', 'attack', 'exploit', 'vulnerability', 'saldırı', 'yetki', 'auth', 'authentication', 'authorization',
  ],
});

const ABSOLUTE_TERMS = Object.freeze([
  'always',
  'never',
  'all',
  'every',
  'guaranteed',
  '100%',
  'eliminate',
  'her zaman',
  'asla',
  'tüm',
  'bütün',
  'hiçbir',
  'kesin',
  'garanti',
  'yüzde yüz',
  'daima',
  'mutlaka',
]);

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function asText(value) {
  return normalizeText(value);
}

function signal(rule, detail, evidence = [], opts = {}) {
  return {
    rule,
    kind: 'risk',
    severity: clamp01(opts.severity ?? 0.5, 0.5),
    confidence: clamp01(opts.confidence ?? 0.6, 0.6),
    flags: Array.isArray(opts.flags) ? [...new Set([rule, ...opts.flags])] : [rule],
    detail,
    evidence: Array.isArray(evidence) ? evidence : [],
    meta: {
      ...((opts.meta && typeof opts.meta === 'object') ? opts.meta : {}),
    },
  };
}

function detectWeakPartialMatch(match, opts = {}) {
  if (!match) return null;
  const confidence = typeof match.confidence === 'number'
    ? match.confidence
    : typeof match.score === 'number'
      ? match.score
      : 0;
  if (confidence >= 0.5) return null;
  return signal(
    RISK_RULES.WEAK_PARTIAL_MATCH,
    'Lexical overlap is weak and should not be treated as verified truth.',
    Array.isArray(match.evidence) ? match.evidence : [],
    {
      severity: 0.4,
      confidence: 0.7,
      flags: [RISK_RULES.WEAK_PARTIAL_MATCH],
      meta: { confidence, ...((opts.meta && typeof opts.meta === 'object') ? opts.meta : {}) },
    }
  );
}

function detectHighRiskDomain(text, opts = {}) {
  const norm = asText(text);
  for (const [domain, tokens] of Object.entries(HIGH_RISK_DOMAINS)) {
    if (tokens.some(token => norm.includes(asText(token)))) {
      return signal(
        RISK_RULES.HIGH_RISK_DOMAIN,
        `High-risk domain detected: ${domain}.`,
        [{ text: String(text), role: 'input' }],
        {
          severity: 0.8,
          confidence: 0.9,
          flags: [RISK_RULES.HIGH_RISK_DOMAIN],
          meta: { domain },
        }
      );
    }
  }
  return null;
}

function detectAbsoluteClaim(text, opts = {}) {
  const norm = asText(text);
  const found = ABSOLUTE_TERMS.find(term => norm.includes(asText(term)));
  if (!found) return null;
  return signal(
    RISK_RULES.ABSOLUTE_CLAIM,
    'Absolute or sweeping claim detected.',
    [{ text: String(text), role: 'input' }],
    {
      severity: 0.7,
      confidence: 0.85,
      flags: [RISK_RULES.ABSOLUTE_CLAIM],
      meta: { term: found },
    }
  );
}

function detectScopeExpansion(stored, incoming, opts = {}) {
  const storedText = asText(stored?.text || stored?.statement || stored?.claim || stored || '');
  const incomingText = asText(incoming?.text || incoming?.statement || incoming?.claim || incoming || '');
  if (!storedText || !incomingText || storedText === incomingText) return null;

  const absolute = detectAbsoluteClaim(incomingText, opts);
  if (!absolute) return null;

  return signal(
    RISK_RULES.SCOPE_EXPANSION,
    'Incoming claim expands scope beyond stored evidence.',
    [
      { text: storedText, role: 'stored' },
      { text: incomingText, role: 'incoming' },
    ],
    {
      severity: 0.7,
      confidence: 0.8,
      flags: [RISK_RULES.SCOPE_EXPANSION, RISK_RULES.ABSOLUTE_CLAIM],
      meta: {
        storedText,
        incomingText,
      },
    }
  );
}

function detectRelationDrift(stored, incoming, opts = {}) {
  const storedText = asText(stored?.text || stored?.statement || stored?.claim || stored || '');
  const incomingText = asText(incoming?.text || incoming?.statement || incoming?.claim || incoming || '');
  if (!storedText || !incomingText || storedText === incomingText) return null;

  const sharedSubject = (stored?.subject || stored?.from || storedText.split(' ')[0]) === (incoming?.subject || incoming?.from || incomingText.split(' ')[0]);
  if (!sharedSubject) return null;

  const storedRelation = asText(stored?.relation || stored?.verb || '');
  const incomingRelation = asText(incoming?.relation || incoming?.verb || '');
  if (storedRelation && incomingRelation && storedRelation === incomingRelation) return null;

  return signal(
    RISK_RULES.RELATION_DRIFT,
    'Relation or predicate meaning drift detected.',
    [
      { text: storedText, role: 'stored' },
      { text: incomingText, role: 'incoming' },
    ],
    {
      severity: 0.55,
      confidence: 0.65,
      flags: [RISK_RULES.RELATION_DRIFT],
      meta: {
        storedRelation,
        incomingRelation,
      },
    }
  );
}

function detectMultilingualAmbiguity(text, opts = {}) {
  const raw = String(text || '');
  const norm = asText(raw);
  const scripts = new Set();
  for (const ch of raw) {
    if (/[A-Za-z]/.test(ch)) scripts.add('latin');
    else if (/[\u0590-\u08FF]/.test(ch)) scripts.add('rtl');
    else if (/[\u0400-\u04FF]/.test(ch)) scripts.add('cyrillic');
    else if (/[\u4E00-\u9FFF]/.test(ch)) scripts.add('cjk');
  }
  const hasMultipleScripts = scripts.size > 1;
  const containsQuestionWords = /\b(what|was|wo|welche|hangi|nedir|ne|quest|que)\b/i.test(raw);
  if (!hasMultipleScripts && !containsQuestionWords) return null;

  return signal(
    RISK_RULES.MULTILINGUAL_AMBIGUITY,
    'Mixed-language or ambiguous query detected.',
    [{ text: raw, role: 'input' }],
    {
      severity: 0.45,
      confidence: 0.7,
      flags: [RISK_RULES.MULTILINGUAL_AMBIGUITY],
      meta: {
        scripts: [...scripts],
      },
    }
  );
}

function detectProvenanceMissing(claim, opts = {}) {
  const provenance = claim?.provenance || opts.provenance || null;
  const provenanceId = provenance?.provenanceId || claim?.provenanceId || opts.provenanceId || '';
  const sourceRef = provenance?.sourceRef || claim?.sourceRef || opts.sourceRef || '';
  const sourceType = provenance?.sourceType || claim?.sourceType || opts.sourceType || '';
  if (provenanceId || sourceRef || sourceType) return null;
  return signal(
    RISK_RULES.PROVENANCE_MISSING,
    'Claim is missing provenance metadata.',
    [],
    {
      severity: 0.6,
      confidence: 0.85,
      flags: [RISK_RULES.PROVENANCE_MISSING],
      meta: {},
    }
  );
}

function runRiskRules(input, opts = {}) {
  const stored = input?.stored || null;
  const incoming = input?.incoming || input || null;
  const incomingText = incoming?.text || incoming?.statement || incoming?.claim || incoming || '';
  return [
    detectWeakPartialMatch(opts.match || input?.match || null, opts),
    detectHighRiskDomain(incomingText, opts),
    detectAbsoluteClaim(incomingText, opts),
    detectScopeExpansion(stored, incoming, opts),
    detectRelationDrift(stored, incoming, opts),
    detectMultilingualAmbiguity(incomingText, opts),
    detectProvenanceMissing(incoming, opts),
    ...runAdversarialSignals({ incoming }, opts),
  ].filter(Boolean);
}

module.exports = {
  ABSOLUTE_TERMS,
  HIGH_RISK_DOMAINS,
  RISK_RULES,
  detectAbsoluteClaim,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectProvenanceMissing,
  detectRelationDrift,
  detectScopeExpansion,
  detectWeakPartialMatch,
  detectDoubleNegation,
  detectWeaselWords,
  detectStrawmanAttribution,
  detectAliasNormalization,
  runRiskRules,
};
