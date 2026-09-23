const { normalizeAuditEvent } = require('./audit-log');
const { normalizeCandidateClaim } = require('./conflict-detector');
const {
  normalizeWorkspaceId,
  nodeStorageKey,
  nowIso,
  normalizeNodeRecord,
  normalizeLoadedEdge,
} = require('./graph-record-utils');
const { loadEmbeddingsLenient, loadJsonGraph } = require('./graph-json-persistence');
const { writeJsonFiles } = require('./graph-json-snapshot');

function stripEmbeddings(graph) {
  const embeddings = {};
  for (const [id, node] of Object.entries(graph._nodes)) {
    if (node.embedding) {
      embeddings[id] = Array.from(node.embedding);
      delete node.embedding;
    }
  }
  return embeddings;
}

function restoreEmbeddings(graph, embeddings) {
  for (const [id, vec] of Object.entries(embeddings)) {
    if (graph._nodes[id]) {
      graph._nodes[id].embedding = new Float64Array(vec);
      continue;
    }
    const [workspaceId, nodeId] = id.includes('::') ? id.split('::') : ['default', id];
    const storageKey = nodeStorageKey(nodeId, workspaceId);
    if (graph._nodes[storageKey]) graph._nodes[storageKey].embedding = new Float64Array(vec);
  }
}

function writeStrippedState(graph, embeddings) {
  if (graph._db && graph._stmts) {
    const saveAll = graph._db.transaction(() => {
      for (const node of Object.values(graph._nodes)) {
        graph._db.prepare(`
          INSERT INTO nodes (id, workspace_id, label, weight, created, created_at, last_accessed, last_seen, vector, provenance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            label = excluded.label,
            weight = excluded.weight,
            last_accessed = excluded.last_accessed,
            last_seen = excluded.last_seen,
            vector = excluded.vector,
            provenance = excluded.provenance
        `).run(
          node.id, normalizeWorkspaceId(node.workspaceId), node.label, node.weight,
          node.created,
          node.created_at || nowIso(),
          node.lastAccessed,
          node.last_seen || node.lastSeen || nowIso(),
          JSON.stringify(node.vector || {}),
          JSON.stringify(node.provenance ?? null),
        );
      }
      for (const edge of graph._edges) {
        graph._stmts.upsertEdge.run(
          normalizeWorkspaceId(edge.workspaceId),
          edge.from,
          edge.to,
          edge.relation,
          edge.weight,
          edge.confidence ?? edge.weight ?? 0.5,
          edge.source || 'manual',
          edge.source_ref || '',
          edge.session_id || '',
          JSON.stringify(edge.evidence || []),
          edge.evidence_type || '',
          JSON.stringify(edge.confidence_history || []),
          edge.company_mode ? 1 : 0,
          edge.source_type || '',
          edge.updated_at || nowIso(),
          edge.created_at || nowIso(),
          JSON.stringify(edge.provenance ?? null),
          JSON.stringify(edge.meta ?? {}),
          edge.created,
          edge.strength ?? 0.5,
        );
      }
      for (const candidate of graph._candidateClaims) {
        graph._stmts.upsertCandidateClaim.run(
          candidate.candidateId,
          normalizeWorkspaceId(candidate.workspaceId),
          candidate.claim || '',
          JSON.stringify(candidate.proposedEdge ?? null),
          JSON.stringify(candidate.provenance ?? null),
          JSON.stringify(candidate.conflict ?? null),
          candidate.recommendation || 'accept',
          candidate.status || 'pending',
          candidate.createdAt || nowIso(),
          candidate.reviewedAt || '',
          candidate.reviewedBy || '',
          JSON.stringify(candidate.warnings || []),
        );
      }
      for (const event of graph._auditEvents) {
        graph._stmts.insertAuditEvent.run(
          event.auditId,
          event.eventType,
          event.targetType || '',
          event.targetId || '',
          event.workspaceId || 'default',
          event.actor || 'system',
          event.timestamp,
          event.sourceRef || '',
          event.provenanceId || '',
          event.trustPolicyVersion || '',
          JSON.stringify(event.details ?? {}),
        );
      }
    });
    saveAll();
  }
  writeJsonFiles(graph, embeddings);
}

function load(graph, sqlitePersistenceError) {
  if (!graph._db || !graph._stmts) return loadJsonGraph(graph);
  graph._nodes = {};
  graph._edges = [];
  graph._candidateClaims = [];
  graph._auditEvents = [];
  graph._outIndex.clear();
  graph._inIndex.clear();

  try {
    const nodes = graph._stmts.allNodes.all();
    const edges = graph._stmts.allEdges.all();
    const candidateRows = graph._stmts.allCandidateClaims.all();
    const auditRows = graph._stmts.allAuditEvents.all();

    if (nodes.length > 0 || edges.length > 0 || auditRows.length > 0 || candidateRows.length > 0) {
      for (const row of nodes) {
        const node = normalizeNodeRecord({
          id: row.id,
          workspaceId: row.workspace_id || 'default',
          label: row.label,
          weight: row.weight,
          created: row.created,
          created_at: row.created_at || '',
          lastAccessed: row.last_accessed,
          last_seen: row.last_seen || '',
          vector: JSON.parse(row.vector || '{}'),
          provenance: JSON.parse(row.provenance || 'null'),
        });
        graph._nodes[nodeStorageKey(node.id, node.workspaceId)] = { ...node, lastAccessed: row.last_accessed };
      }
      graph._edges = edges.map(row => normalizeLoadedEdge({
        workspaceId: row.workspace_id || 'default',
        from: row.from_id,
        to: row.to_id,
        relation: row.relation,
        weight: row.weight,
        confidence: row.confidence ?? row.weight ?? 0.5,
        source: row.source || 'manual',
        source_ref: row.source_ref || '',
        session_id: row.session_id || '',
        evidence: JSON.parse(row.evidence || '[]'),
        evidence_type: row.evidence_type || '',
        confidence_history: JSON.parse(row.confidence_history || '[]'),
        company_mode: Number(row.company_mode || 0),
        source_type: row.source_type || '',
        updated_at: row.updated_at || '',
        created_at: row.created_at || '',
        provenance: JSON.parse(row.provenance || 'null'),
        meta: JSON.parse(row.meta || '{}'),
        created: row.created,
        strength: row.strength,
      }));
      graph._candidateClaims = candidateRows.map(row => normalizeCandidateClaim({
        candidateId: row.candidate_id,
        workspaceId: row.workspace_id || 'default',
        claim: row.claim || '',
        proposedEdge: JSON.parse(row.proposed_edge || 'null'),
        provenance: JSON.parse(row.provenance || 'null'),
        conflict: JSON.parse(row.conflict || 'null'),
        recommendation: row.recommendation || 'accept',
        status: row.status || 'pending',
        createdAt: row.created_at || '',
        reviewedAt: row.reviewed_at || '',
        reviewedBy: row.reviewed_by || '',
        warnings: JSON.parse(row.warnings || '[]'),
      }));
      graph._auditEvents = auditRows.map(row => normalizeAuditEvent({
        auditId: row.audit_id,
        eventType: row.event_type,
        targetType: row.target_type || '',
        targetId: row.target_id || '',
        workspaceId: row.workspace_id || 'default',
        actor: row.actor || 'system',
        timestamp: row.timestamp,
        sourceRef: row.source_ref || '',
        provenanceId: row.provenance_id || '',
        trustPolicyVersion: row.trust_policy_version || '',
        details: JSON.parse(row.details || '{}'),
      }));
      graph.rebuildIndex();
      loadEmbeddingsLenient(graph);
      return;
    }
  } catch (error) {
    throw sqlitePersistenceError('load', error);
  }
  return loadJsonGraph(graph);
}

module.exports = {
  stripEmbeddings,
  restoreEmbeddings,
  writeStrippedState,
  load,
};
