'use strict';

function normalizeSubject(value) {
  return String(value || '').toLowerCase().replace(/i\u0307/g, 'i').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
}

function resolveKnownSubject(graph, subject, workspaceId = 'default') {
  const direct = graph.getNode(subject, workspaceId);
  if (direct) return direct.id;
  const normalized = normalizeSubject(subject);
  const node = Object.values(graph.getNodes(workspaceId)).find(candidate => (
    normalizeSubject(candidate.id) === normalized || normalizeSubject(candidate.label) === normalized
  ));
  return node ? node.id : null;
}

module.exports = { resolveKnownSubject };
