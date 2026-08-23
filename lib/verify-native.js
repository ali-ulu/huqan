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
  const normalized = typeof kernel?.normalizeWord === 'function'
    ? kernel.normalizeWord(value)
    : normalizeText(value);
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

function phraseMatches(left = '', right = '') {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  if (rightWords.length >= 2 && left.includes(right)) return true;
  if (leftWords.length >= 2 && right.includes(left)) return true;
  if (right.length >= 4 && left.includes(right)) return true;
  return false;
}

function sharedPrefixLength(left = '', right = '') {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function hasSharedSemanticAnchor(left = '', right = '') {
  if (!left || !right) return false;
  if (phraseMatches(left, right) || phraseMatches(right, left)) return true;
  const leftTokens = normalizeText(left).split(/\s+/).filter(token => token.length >= 4);
  const rightTokens = normalizeText(right).split(/\s+/).filter(token => token.length >= 4);
  for (const a of leftTokens) {
    for (const b of rightTokens) {
      if (a === b || a.includes(b) || b.includes(a) || sharedPrefixLength(a, b) >= 5) {
        return true;
      }
    }
  }
  return false;
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
      supportScore = Math.max(rawConfidence, 0.75);
    } else if (hasDirectEvidence) {
      supportScore = Math.max(rawConfidence, 0.8);
    } else {
      supportScore = Math.max(rawConfidence, 0.8);
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
  if (hasPartialEvidence && status === 'verified' && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
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
  buildVerifySemanticTrust,
};

