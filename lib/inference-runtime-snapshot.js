'use strict';

const { createHash } = require('node:crypto');
const { atom, constant } = require('./inference-rule-ir');
const { factKey, normalizeRules } = require('./inference-semi-naive-values');
const { isContestingCandidate } = require('./contested-read-policy');

const LIMITS = Object.freeze({ maxOperations: 100000, maxRounds: 64, maxDerivedFacts: 1000, timeoutMs: 1000, maxDepth: 32 });
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function boundedLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('limits must be an object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(LIMITS, key) || !Number.isInteger(input[key]) || input[key] < 1 || input[key] > LIMITS[key]) {
      throw new TypeError(`invalid inference limit: ${key}`);
    }
  }
  return { ...LIMITS, ...input };
}
function snapshotGraph(kernel, workspaceId) {
  const edges = kernel.graph.getAllEdges(workspaceId);
  if (edges.length > 10000) throw new RangeError('inference graph snapshot exceeds 10000 edges');
  const conflicts = kernel.getCandidateClaims({ workspaceId });
  const supports = new Map();
  for (const edge of edges) {
    // Previously inferred edges cannot silently become independent evidence.
    if (edge.provenance?.sourceType === 'background_inference') continue;
    if (edge.status && edge.status !== 'active') continue;
    if (edge.celiski || edge.confidence === 0) continue;
    const targetId = `${edge.from}|${edge.relation}|${edge.to}`;
    if (conflicts.some(candidate => isContestingCandidate(candidate, { targetId }))) continue;
    const provenanceId = edge.provenance?.provenanceId;
    if (typeof provenanceId !== 'string' || !provenanceId) continue;
    const fact = atom(edge.relation, [constant(edge.from), constant(edge.to)]);
    const detail = { fact, provenanceRefs: [provenanceId], sourceRefs: [], state: 'active' };
    const sourceRef = edge.provenance?.sourceRef || edge.sourceRef;
    if (typeof sourceRef === 'string' && sourceRef) detail.sourceRefs.push(sourceRef);
    supports.set(factKey(fact), detail);
  }
  const details = [...supports.values()].sort((a, b) => factKey(a.fact).localeCompare(factKey(b.fact)));
  return { graphSnapshotId: digest(details), facts: details.map(item => item.fact), details };
}
function snapshotRules(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 128) throw new TypeError('1..128 rules required');
  const rules = normalizeRules(input);
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new TypeError('duplicate rule id');
  return { rules, ruleSnapshotId: digest(rules) };
}
module.exports = { digest, boundedLimits, snapshotGraph, snapshotRules };
