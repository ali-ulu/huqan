const { stripCopulaOrKeep } = require('./turkish-copula');
const { DEFAULT_SEMANTIC_THRESHOLDS, normalizeSemanticClassification } = require('./semantic-score');
const { decomposeClaim } = require('./claim-decomposition');
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require('./reasoning-trace');
const {
  detectAbsoluteClaim,
  detectAliasNormalization,
  detectDoubleNegation,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectStrawmanAttribution,
  detectWeakPartialMatch,
  detectWeaselWords,
} = require('./risk-rules');
const { runContradictionRules } = require('./contradiction-rules');
const { analyzeFuzzyOverlap } = require('./fuzzy-normalization');
const { runSemanticSignals } = require('./semantic-signals');
const { detectTypeLatticeConflict } = require('./type-lattice');
const { normalizeText } = require('./text-utils');
const { resolveEntity } = require('./entity-resolution');
const { normalizeWorkspaceId } = require('./workspace-id');

function edgeClaim(edge = {}) {
  return {
    text: `${edge.from || ''} ${edge.relation || ''} ${edge.to || ''}`.trim(),
    subject: edge.from || '',
    relation: edge.relation || '',
    object: edge.to || '',
    to: edge.to || '',
  };
}

function normalizeForVerify(kernel, value = '') {
  const rawWords = String(value || '').trim().split(/\s+/).filter(Boolean);
  const normalized = rawWords.map(word => {
    const token = word.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, '');
    return typeof kernel?.normalizeWord === 'function' ? kernel.normalizeWord(token) : normalizeText(token);
  }).filter(Boolean).join(' ');
  return stripCopulaSuffix(foldTurkishAscii(normalized));
}

function foldTurkishAscii(value = '') {
  return String(value || '')
    .replace(/[\u0131\u0130]/g, 'i')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[şŞ]/g, 's')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c');
}

/**
 * Strips the copula from the final word, where a Turkish predicate noun sits.
 *
 * Matching on the ending alone collapsed distinct words onto one token --
 * `k\u00fclt\u00fcr` and `k\u00fcl` both became `kul`, `m\u00fcd\u00fcr` and `m\u00fc` both became `mu`, and
 * `t\u00fcr` became the empty string -- so two unrelated claims compared equal
 * through `phraseMatches` and `hasSharedSemanticAnchor` (#1106). `stripCopula`
 * refuses those, leaving the word intact.
 */
function stripCopulaSuffix(value = '') {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const lastIndex = words.length - 1;
  words[lastIndex] = stripCopulaOrKeep(words[lastIndex]);
  return words.filter(Boolean).join(' ');
}

function sharedPrefixLength(left = '', right = '') {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

const TURKISH_INFLECTION_SUFFIXES = new Set([
  'a', 'e', 'ı', 'i', 'u', 'ü', 'da', 'de', 'ta', 'te', 'ya', 'ye', 'yı', 'yi', 'yu', 'yü',
  'dan', 'den', 'tan', 'ten', 'lar', 'ler', 'ın', 'in', 'un', 'ün', 'nın', 'nin', 'nun', 'nün',
  'dır', 'dir', 'dur', 'dür', 'tır', 'tir', 'tur', 'tür',
]);
const TURKISH_PRIVATIVE_SUFFIXES = new Set(['sız', 'siz', 'suz', 'süz']);
const TURKISH_SEMANTIC_TAILS = new Set([
  'li', 'lı', 'lu', 'lü', 'ci', 'cı', 'cu', 'cü', 'gi', 'gı', 'gu', 'gü', 'ki', 'kı', 'ku', 'kü',
]);
const TURKISH_CONSONANT_ALTERNATIONS = new Set(['kg', 'gk', 'dt', 'td', 'bp', 'pb', 'çc', 'cc']);
const PREDICATE_WRAPPER_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'bir', 'bu', 'şu', 'o', 'mi', 'mı', 'mu', 'mü', 'causes', 'cause', 'leads', 'lead', 'to', 'triggers', 'trigger',
  'prevents', 'prevent', 'blocks', 'stops', 'reduces', 'inhibits', 'enables', 'enable',
  'depends', 'on', 'neden', 'olur', 'yol', 'açar', 'sebep', 'tetikler', 'önler', 'onler', 'engeller',
  'durdurur', 'sağlar', 'mümkün', 'kılar', 'olanak', 'verir', 'etkinleştirir', 'bağlı',
  'gerektirir', 'dayanır', 'olmadan', 'yapar', 'yapabilir',
]);

function containsWholePhrase(haystack, needle) {
  if (haystack === needle) return true;
  const haystackWords = haystack.split(/\s+/).filter(Boolean);
  const needleWords = needle.split(/\s+/).filter(Boolean);
  if (needleWords.length === 0 || haystackWords.length < needleWords.length) return false;
  for (let start = 0; start <= haystackWords.length - needleWords.length; start += 1) {
    if (needleWords.every((word, index) => haystackWords[start + index] === word)) {
      const outside = [...haystackWords.slice(0, start), ...haystackWords.slice(start + needleWords.length)];
      if (outside.every(word => PREDICATE_WRAPPER_WORDS.has(word))) return true;
    }
  }
  return false;
}

function isAllowedTurkishInflection(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b || a.includes(' ') || b.includes(' ')) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 5 || !longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return suffix.length > 0
    && suffix.length <= 4
    && !TURKISH_PRIVATIVE_SUFFIXES.has(suffix)
    && (TURKISH_INFLECTION_SUFFIXES.has(suffix) || TURKISH_SEMANTIC_TAILS.has(suffix))
    && sharedPrefixLength(shorter, longer) >= 5;
}

function hasPlausibleSemanticPrefix(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b || a.includes(' ') || b.includes(' ')) return false;
  const prefix = sharedPrefixLength(a, b);
  if (prefix < 5 || Math.abs(a.length - b.length) > 4) return false;
  const tails = [a.slice(prefix), b.slice(prefix)];
  if (tails.every(tail => !tail || TURKISH_SEMANTIC_TAILS.has(tail) || TURKISH_INFLECTION_SUFFIXES.has(tail))) return true;
  if (prefix >= 5 && a[prefix] && b[prefix] && TURKISH_CONSONANT_ALTERNATIONS.has(a[prefix] + b[prefix])) {
    const alternatedTails = [a.slice(prefix + 1), b.slice(prefix + 1)];
    return alternatedTails.every(tail => !tail || TURKISH_SEMANTIC_TAILS.has(tail) || TURKISH_INFLECTION_SUFFIXES.has(tail));
  }
  return false;
}

function hasAllowedWrappedWord(haystack, needle) {
  const words = normalizeText(haystack).split(/\s+/).filter(Boolean);
  const target = normalizeText(needle);
  if (!target || target.includes(' ')) return false;
  return words.some((word, index) => {
    if (word !== target && !isAllowedTurkishInflection(word, target)) return false;
    return words.every((outside, outsideIndex) => outsideIndex === index || PREDICATE_WRAPPER_WORDS.has(outside));
  });
}

function phraseMatches(left = '', right = '') {
  if (!left || !right) return false;
  if (left === right) return true;
  if (containsWholePhrase(left, right) || hasAllowedWrappedWord(left, right)) return true;
  return isAllowedTurkishInflection(left, right);
}

function hasSharedSemanticAnchor(left = '', right = '') {
  if (!left || !right) return false;
  if (phraseMatches(left, right) || phraseMatches(right, left)) return true;
  const leftTokens = normalizeText(left).split(/\s+/).filter(token => token.length >= 4);
  const rightTokens = normalizeText(right).split(/\s+/).filter(token => token.length >= 4);
  return leftTokens.some(a => rightTokens.some(b => (
    a === b || isAllowedTurkishInflection(a, b) || hasPlausibleSemanticPrefix(a, b)
  )));
}

function isPreventRelation(relation = '') {
  const normalized = normalizeText(relation);
  return ['prevents', 'prevent', 'blocks', 'stops', 'reduces', 'inhibits', 'onler', 'önler', 'engeller', 'azaltir', 'azaltır'].includes(normalized);
}

function uniqueFlags(signals = []) {
  return [...new Set([].concat(...signals.map(signal => Array.isArray(signal?.flags) ? signal.flags : [])))].filter(Boolean);
}

function maxSignalScore(signals = []) {
  return signals.reduce((max, signal) => Math.max(
    max,
    Number(signal?.severity) || 0,
    Number(signal?.confidence) || 0,
  ), 0);
}

function buildVerifySemanticTrust({
  statement = '',
  result = {},
  evidence = [],
  subject = '',
  predicate = '',
  edges = [],
  workspaceId = 'default',
  pathSearch = null,
  fuzzy = null,
  typeConflict = null,
  contradictionSignals: seedContradictionSignals = [],
}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const evidenceKinds = [...new Set(evidenceList.map(item => String(item?.kind || '').trim()).filter(Boolean))];
  const rawConfidence = Number(result?.confidence) || 0;
  const hasPartialEvidence = evidenceKinds.includes('partial_match');
  const hasPathEvidence = evidenceKinds.includes('path');
  const hasDirectEvidence = evidenceKinds.includes('direct_edge');

  let supportScore = 0;
  if (result?.status === 'verified') {
    if (hasPartialEvidence) {
      supportScore = Math.min(rawConfidence || 0.35, 0.49);
    } else if (hasPathEvidence) {
      supportScore = rawConfidence;
    } else if (hasDirectEvidence) {
      supportScore = rawConfidence;
    } else {
      supportScore = rawConfidence;
    }
  } else if (result?.status === 'contradicted') {
    supportScore = 0;
  } else {
    supportScore = hasPartialEvidence ? Math.min(rawConfidence || 0.35, 0.49) : rawConfidence;
  }

  const riskSignals = [];
  const contradictionSignals = Array.isArray(seedContradictionSignals) ? [...seedContradictionSignals] : [];

  if (typeConflict) contradictionSignals.push(typeConflict);

  const weakPartial = (evidenceList.length > 0 || result?.status === 'verified')
    ? detectWeakPartialMatch({ confidence: supportScore, evidence: evidenceList }, {})
    : null;
  if (weakPartial) riskSignals.push(weakPartial);

  const highRisk = detectHighRiskDomain(statement, {});
  if (highRisk) riskSignals.push(highRisk);

  const absolute = detectAbsoluteClaim(statement, {});
  if (absolute) riskSignals.push(absolute);

  const doubleNegation = detectDoubleNegation(statement, {});
  if (doubleNegation) riskSignals.push(doubleNegation);

  const weaselWords = detectWeaselWords(statement, {});
  if (weaselWords) riskSignals.push(weaselWords);

  const strawman = detectStrawmanAttribution(statement, {});
  if (strawman) riskSignals.push(strawman);

  const aliasNormalization = detectAliasNormalization(statement, {});
  if (aliasNormalization) riskSignals.push(aliasNormalization);

  const multilingual = detectMultilingualAmbiguity(statement, {});
  if (multilingual) riskSignals.push(multilingual);

  if (result?.status !== 'verified' && Array.isArray(edges) && edges.length > 0) {
    const incoming = {
      text: statement,
      subject,
      relation: predicate,
      object: predicate,
      to: predicate,
    };
    for (const edge of edges) {
      const signals = runContradictionRules(edgeClaim(edge), incoming, {});
      if (Array.isArray(signals)) contradictionSignals.push(...signals);
    }
  }

  if (result?.status === 'contradicted' && contradictionSignals.length === 0) {
    contradictionSignals.push({
      rule: 'VERIFY_CONTRADICTION',
      kind: 'contradiction',
      severity: 0.9,
      confidence: Math.max(0.7, rawConfidence),
      flags: ['VERIFY_CONTRADICTION'],
      detail: 'Verify returned contradiction.',
      evidence: evidenceList,
      meta: { statement, subject, predicate },
    });
  }

  const contradictionScore = maxSignalScore(contradictionSignals);
  const riskScore = maxSignalScore(riskSignals);

  let status = ['verified', 'contradicted', 'unknown'].includes(result?.status) ? result.status : 'unknown';
  if ((hasPartialEvidence || hasPathEvidence || hasDirectEvidence) && status === 'verified' && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    status = 'unknown';
  } else if (status !== 'verified' && contradictionScore >= DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict) {
    status = 'contradicted';
  }

  const matchType = hasPartialEvidence
    ? 'partial_match'
    : hasPathEvidence
      ? 'path'
      : hasDirectEvidence
        ? 'direct_edge'
        : contradictionSignals.length > 0
          ? 'contradiction'
          : 'unknown';

  const signals = [...contradictionSignals, ...riskSignals];
  const warnings = uniqueFlags(signals);
  const semanticTrust = normalizeSemanticClassification({
    status,
    supportScore,
    contradictionScore,
    riskScore,
    matchType,
    warnings,
    risk: {
      flags: warnings,
      domain: highRisk?.meta?.domain || null,
      manipulation: false,
      absoluteClaim: Boolean(absolute),
      relationDrift: warnings.includes('RELATION_DRIFT'),
      highRisk: Boolean(highRisk),
    },
    signals,
      meta: {
        statement,
        subject,
        predicate,
        workspaceId,
        evidenceKinds,
        pathSearch,
        fuzzy,
        thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
      },
    });

  return {
    ...semanticTrust,
    confidence: Math.max(rawConfidence, semanticTrust.supportScore || 0, semanticTrust.contradictionScore || 0),
    thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
  };
}

function pathSupportConfidence(graph, path, workspaceId) {
  const weights = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const edge = graph.getEdges(from, workspaceId).find(candidate => candidate.to === to)
      || graph.getEdges(to, workspaceId).find(candidate => candidate.to === from);
    const weight = edge?.confidence ?? edge?.weight;
    if (typeof weight === 'number' && Number.isFinite(weight)) weights.push(weight);
  }
  const weakestWeight = weights.length > 0 ? Math.min(...weights) : 0.5;
  return Number(Math.min(0.95, weakestWeight + 0.3).toFixed(6));
}

function normalizeNegationTarget(value) {
  return String(value || '')
    .replace(/\s*\[değil\]\s*$/i, '')
    .replace(/(?:değildir|değil|yabilir|yebilir|abilir|ebilir|yamaz|yemez|amaz|emez|maz|mez)$/i, '')
    .trim();
}

module.exports = {
  normalizeWorkspaceId,
  edgeClaim,
  normalizeForVerify,
  foldTurkishAscii,
  stripCopulaSuffix,
  phraseMatches,
  sharedPrefixLength,
  hasSharedSemanticAnchor,
  isPreventRelation,
  uniqueFlags,
  maxSignalScore,
  normalizeNegationTarget,
  pathSupportConfidence,
  buildVerifySemanticTrust,
};

