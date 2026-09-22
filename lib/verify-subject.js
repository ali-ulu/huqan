'use strict';

// Extracted from VerifyService._extractSubjectAndPredicate by #2140.
// Segments a statement into subject/predicate by longest node-name match
// (verbatim or lookup form), falling back to first-token subject. Takes the
// kernel it reads (graph nodes, word normalization) as an argument — the
// same seam normalizeForVerify already documents — so the service method
// stays a one-line delegation with no new private surface.

const { normalizeText } = require('./text-utils');
const { normalizeForVerify } = require('./verify-turkish-text');

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

  for (const node of nodes) {
    if (normalizedStatement === node.normalized || normalizedStatement.startsWith(`${node.normalized} `)) {
      return {
        subject: node.id,
        predicate: normalizedStatement.slice(node.normalized.length).trim(),
        matchedSubject: true,
      };
    }
    if (node.lookup && (normalizedStatementForLookup === node.lookup || normalizedStatementForLookup.startsWith(`${node.lookup} `))) {
      return {
        subject: node.id,
        predicate: normalizedStatementForLookup.slice(node.lookup.length).trim(),
        matchedSubject: true,
      };
    }
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
