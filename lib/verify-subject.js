'use strict';

// Extracted from VerifyService._extractSubjectAndPredicate by #2140.
// Segments a statement into subject/predicate by longest node-name match
// (verbatim or lookup form), falling back to first-token subject. Takes the
// kernel it reads (graph nodes, word normalization) as an argument — the
// same seam normalizeForVerify already documents — so the service method
// stays a one-line delegation with no new private surface.

const { normalizeText } = require('./text-utils');
const { normalizeForVerify } = require('./verify-turkish-text');

const ENGLISH_DETERMINERS = new Set(['a', 'an', 'the']);

// #3704: kernel.extractFacts routes a determiner-led English sentence to the
// EN pack, which drops the article ("a cat is a mammal" -> subject "cat").
// Segment the claim read back with the same rule, or the node learn wrote can
// never match its own statement here: matching below only finds a node name as
// a prefix, and the statement opens with "the"/"a"/"an" instead. The pack
// resolver is the Platform-injected seam (lib/ must not import nlp/index.js),
// so an absent resolver simply leaves the statement as it is.
function withoutLeadingEnglishDeterminer(kernel, statement, normalized) {
  const resolveNlp = kernel && kernel._resolveNlpPack;
  if (typeof resolveNlp !== 'function' || typeof statement !== 'string') return normalized;
  const first = normalized.split(/\s+/)[0];
  if (!ENGLISH_DETERMINERS.has(first)) return normalized;
  const detector = resolveNlp('auto');
  const detected = detector && typeof detector.detectLanguage === 'function'
    ? detector.detectLanguage(statement)
    : null;
  return detected === 'en' ? normalized.slice(first.length).trim() : normalized;
}

function firstNodeMatch(nodes, normalized, normalizedLookup) {
  for (const node of nodes) {
    if (normalized === node.normalized || normalized.startsWith(`${node.normalized} `)) {
      return {
        subject: node.id,
        predicate: normalized.slice(node.normalized.length).trim(),
        matchedSubject: true,
      };
    }
    if (normalizedLookup && node.lookup && (normalizedLookup === node.lookup || normalizedLookup.startsWith(`${node.lookup} `))) {
      return {
        subject: node.id,
        predicate: normalizedLookup.slice(node.lookup.length).trim(),
        matchedSubject: true,
      };
    }
  }
  return null;
}

function extractSubjectAndPredicate(kernel, statement, workspaceId, parts = null) {
  const normalizedStatement = normalizeText(statement);
  const normalizedStatementForLookup = normalizeForVerify(kernel, statement);
  const nodes = Object.values(kernel.graph.getNodes(workspaceId))
    .map(node => ({
      id: node.id,
      normalized: normalizeText(node.id),
      lookup: normalizeForVerify(kernel, node.id),
    }))
    .filter(node => node.normalized || node.lookup)
    .sort((a, b) => Math.max(b.normalized.length, b.lookup.length) - Math.max(a.normalized.length, a.lookup.length));

  // Verbatim forms first, exactly as before, so no statement that matched a
  // node already matches a different one now. The determiner-stripped retry
  // only runs when both forms miss.
  const matched = firstNodeMatch(nodes, normalizedStatement, normalizedStatementForLookup);
  if (matched) return matched;

  const strippedStatement = withoutLeadingEnglishDeterminer(kernel, statement, normalizedStatement);
  if (strippedStatement && strippedStatement !== normalizedStatement) {
    const strippedMatch = firstNodeMatch(nodes, strippedStatement, null);
    if (strippedMatch) return strippedMatch;
  }

  const tokens = Array.isArray(parts) && parts.length > 0
    ? parts
    : normalizedStatement.split(/\s+/).filter(Boolean);
  const subject = kernel.normalizeWord(tokens[0] || '');
  const predicate = tokens.slice(1).join(' ');
  return {
    subject,
    predicate,
    matchedSubject: false,
  };
}

module.exports = { extractSubjectAndPredicate };
