const { normalizeText } = require('./text-utils');

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function tokenize(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

function classifyTestRisk(input = {}, opts = {}) {
  const text = String(input?.text || input?.sourceClaim || input?.claim || opts.text || '');
  const normalized = normalizeText(text);
  const tokens = new Set(tokenize(text));

  const risk = {
    score: 0,
    flags: [],
    domain: null,
    manipulation: false,
    absoluteClaim: false,
    relationDrift: false,
    highRisk: false,
  };

  const domainHints = [
    ['aviation', ['b737', 'a380', 'c172', 'eddf', 'tcas', 'v1', 'vr', 'squawk', 'mayday', 'pan-pan']],
    ['medical', ['aspirin', 'ilaç', 'tedavi', 'hastalık', 'kanser', 'aşı', 'insülin']],
    ['legal', ['hukuk', 'dava', 'kvkk', 'gdpr', 'sözleşme']],
  ];

  for (const [domain, hints] of domainHints) {
    if (hints.some(hint => normalized.includes(normalizeText(hint)))) {
      risk.domain = domain;
      risk.highRisk = true;
      risk.flags.push('HIGH_RISK_DOMAIN');
      risk.score = Math.max(risk.score, 0.75);
      break;
    }
  }

  const absoluteTerms = ['always', 'never', 'all', 'every', 'guaranteed', 'her zaman', 'asla', 'tüm', 'bütün', 'hiçbir', 'kesin', 'garanti'];
  if (absoluteTerms.some(term => normalized.includes(normalizeText(term)))) {
    risk.absoluteClaim = true;
    risk.flags.push('ABSOLUTE_CLAIM');
    risk.score = Math.max(risk.score, 0.65);
  }

  if (tokens.has('not') && normalized.includes('not not')) {
    risk.flags.push('DOUBLE_NEGATION');
    risk.score = Math.max(risk.score, 0.55);
  }

  if (normalized.includes('according to') || normalized.includes('dedi ki')) {
    risk.manipulation = true;
    risk.flags.push('STRAWMAN_ATTRIBUTION');
    risk.score = Math.max(risk.score, 0.6);
  }

  if (normalized.includes('genellikle') || normalized.includes('bazen') || normalized.includes('neredeyse') || normalized.includes('usually') || normalized.includes('almost')) {
    risk.flags.push('WEASEL_WORDS');
    risk.score = Math.max(risk.score, 0.45);
  }

  if (normalized.includes('react native') && tokens.has('rn')) {
    risk.flags.push('ALIAS_NORMALIZATION');
    risk.score = Math.max(risk.score, 0.35);
  }

  return {
    ...risk,
    score: clamp01(risk.score, 0),
    warnings: [...new Set(risk.flags)],
    meta: {
      sourceClaim: text,
      normalized,
    },
  };
}

function normalizeTestSuggestion(input = {}, opts = {}) {
  const sourceClaim = String(input?.sourceClaim || input?.claim || opts.sourceClaim || opts.claim || '').trim();
  const risk = classifyTestRisk(input, opts);
  const suggestionId = `test-${Buffer.from(normalizeText(sourceClaim) || 'unknown').toString('hex').slice(0, 16)}`;

  const recommendedTestName = input?.recommendedTestName || opts.recommendedTestName || (() => {
    if (risk.flags.includes('HIGH_RISK_DOMAIN')) return 'stress-high-risk-regression';
    if (risk.flags.includes('ABSOLUTE_CLAIM')) return 'stress-absolute-claims';
    if (risk.flags.includes('STRAWMAN_ATTRIBUTION')) return 'stress-adversarial-attribution';
    return 'stress-semantic-regression';
  })();

  return {
    suggestionId,
    sourceClaim,
    risk,
    recommendedTestName,
    given: input?.given || opts.given || sourceClaim,
    when: input?.when || opts.when || 'the claim is evaluated by the semantic gate',
    then: input?.then || opts.then || 'the claim should not be promoted to verified truth without support',
    warnings: Array.isArray(input?.warnings) ? [...new Set(input.warnings.filter(Boolean))] : [...new Set(risk.warnings)],
    meta: {
      ...((input?.meta && typeof input.meta === 'object' && !Array.isArray(input.meta)) ? input.meta : {}),
      classification: risk.flags.length > 0 ? 'needs_review' : 'suggestion',
    },
  };
}

function suggestRegressionTest(input = {}, opts = {}) {
  const suggestion = normalizeTestSuggestion(input, opts);
  return {
    ...suggestion,
    canAutoWrite: false,
    action: 'suggest',
  };
}

module.exports = {
  classifyTestRisk,
  normalizeTestSuggestion,
  suggestRegressionTest,
};
