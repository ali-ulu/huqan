const { normalizeText } = require('./text-utils');

const ADVERSARIAL_RULES = Object.freeze({
  DOUBLE_NEGATION: 'DOUBLE_NEGATION',
  WEASEL_WORDS: 'WEASEL_WORDS',
  STRAWMAN_ATTRIBUTION: 'STRAWMAN_ATTRIBUTION',
  ALIAS_NORMALIZATION: 'ALIAS_NORMALIZATION',
});

const WEASEL_WORDS = Object.freeze([
  'genellikle',
  'bazen',
  'nadiren',
  'çoğunlukla',
  'sıklıkla',
  'neredeyse',
  'usually',
  'almost',
  'often',
  'sometimes',
  'typically',
  'likely',
  'probably',
  'may',
  'might',
]);

const ALIAS_GROUPS = Object.freeze([
  { canonical: 'react native', aliases: ['react native', 'react-native', 'rn'] },
  { canonical: 'node js', aliases: ['node js', 'node.js', 'nodejs'] },
]);

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

function normalizeAliasText(text) {
  const raw = String(text || '');
  let norm = asText(raw);
  for (const group of ALIAS_GROUPS) {
    for (const alias of group.aliases) {
      const aliasNorm = asText(alias);
      if (!aliasNorm) continue;
      const re = new RegExp(`\\b${aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      norm = norm.replace(re, group.canonical);
    }
  }
  return norm.replace(/\s+/g, ' ').trim();
}

function detectDoubleNegation(text, opts = {}) {
  const norm = asText(text);
  if (!norm) return null;
  const negCount = NEGATION_TOKENS.reduce((count, token) => {
    const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const matches = norm.match(pattern);
    return count + (matches ? matches.length : 0);
  }, 0);
  if (negCount < 2 && !/\b(not\s+not|değil\s+değil|yok\s+yok|asla\s+asla)\b/i.test(norm)) return null;
  return signal(
    ADVERSARIAL_RULES.DOUBLE_NEGATION,
    'Double negation or repeated negation detected.',
    [{ text: String(text), role: 'input' }],
    {
      severity: 0.55,
      confidence: 0.8,
      flags: [ADVERSARIAL_RULES.DOUBLE_NEGATION],
      meta: { negCount },
    }
  );
}

function detectWeaselWords(text, opts = {}) {
  const norm = asText(text);
  if (!norm) return null;
  const found = WEASEL_WORDS.find(term => norm.includes(asText(term)));
  if (!found) return null;
  return signal(
    ADVERSARIAL_RULES.WEASEL_WORDS,
    'Weasel language detected; claim should not be treated as strong evidence.',
    [{ text: String(text), role: 'input' }],
    {
      severity: 0.35,
      confidence: 0.75,
      flags: [ADVERSARIAL_RULES.WEASEL_WORDS],
      meta: { term: found },
    }
  );
}

function detectStrawmanAttribution(text, opts = {}) {
  const raw = String(text || '');
  const norm = asText(raw);
  const patterns = [
    /\b(dedi ki|iddia etti ki|söyledi ki|söylüyor ki)\b/i,
    /\b(said that|claimed that|argued that|according to)\b/i,
  ];
  const hasAttribution = patterns.some(pattern => pattern.test(raw) || pattern.test(norm));
  if (!hasAttribution) return null;
  return signal(
    ADVERSARIAL_RULES.STRAWMAN_ATTRIBUTION,
    'Attribution framing detected; quoted claims should not be treated as ground truth.',
    [{ text: raw, role: 'input' }],
    {
      severity: 0.5,
      confidence: 0.7,
      flags: [ADVERSARIAL_RULES.STRAWMAN_ATTRIBUTION],
      meta: {
        attribution: true,
      },
    }
  );
}

function detectAliasNormalization(text, opts = {}) {
  const raw = String(text || '');
  const canonical = normalizeAliasText(raw);
  const normalized = asText(raw);
  if (!raw || canonical === normalized) return null;
  return signal(
    ADVERSARIAL_RULES.ALIAS_NORMALIZATION,
    'Alias normalization applied to preserve semantic equivalence.',
    [{ text: raw, role: 'input' }],
    {
      severity: 0.2,
      confidence: 0.85,
      flags: [ADVERSARIAL_RULES.ALIAS_NORMALIZATION],
      meta: {
        canonicalText: canonical,
      },
    }
  );
}

function runAdversarialSignals(input, opts = {}) {
  const stored = input?.stored || null;
  const incoming = input?.incoming || input || null;
  const incomingText = incoming?.text || incoming?.statement || incoming?.claim || incoming || '';
  return [
    detectDoubleNegation(incomingText, opts),
    detectWeaselWords(incomingText, opts),
    detectStrawmanAttribution(incomingText, opts),
    detectAliasNormalization(incomingText, opts),
  ].filter(Boolean);
}

module.exports = {
  ADVERSARIAL_RULES,
  ALIAS_GROUPS,
  NEGATION_TOKENS,
  WEASEL_WORDS,
  detectAliasNormalization,
  detectDoubleNegation,
  detectStrawmanAttribution,
  detectWeaselWords,
  normalizeAliasText,
  runAdversarialSignals,
};
