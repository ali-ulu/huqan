// Pure-ish HTTP read-model projection for /graph-data.
// The server owns routing, auth, and response writing; this module owns only
// public Graph/Memory reads and the response-shaped projection.
function buildGraphData({ graph, memory, getSafeMemoryLabel, workspaceId = 'default' }) {
  const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
  const nodesById = graph.getNodes(scope);
  const scopedEdges = graph.getAllEdges(scope);
  const nodeEdges = new Map();
  for (const edge of scopedEdges) {
    if (!nodeEdges.has(edge.from)) nodeEdges.set(edge.from, []);
    if (!nodeEdges.has(edge.to)) nodeEdges.set(edge.to, []);
    nodeEdges.get(edge.from).push(edge);
    nodeEdges.get(edge.to).push(edge);
  }

  const nodes = Object.values(nodesById).map(n => {
    const edges = nodeEdges.get(n.id) || [];
    const sources = [...new Set(edges.map(e => e.source || e.source_type || 'manual').filter(Boolean))].slice(0, 3);
    const confidence = edges.length > 0
      ? edges.reduce((max, e) => Math.max(max, Number(e.confidence ?? e.weight ?? 0.5)), 0)
      : Number(n.weight ?? 0.5);
    const evidenceCount = edges.reduce((sum, e) => sum + (Array.isArray(e.evidence) ? e.evidence.length : 0), 0);
    return {
      id: n.id,
      label: n.label,
      weight: n.weight,
      edgeCount: graph.getEdges(n.id, scope).length,
      confidence,
      sources,
      evidenceCount,
      workspaceId: n.workspaceId || scope,
      last_seen: n.last_seen || n.lastSeen || '',
      created_at: n.created_at || '',
    };
  });

  // Çok fazla node varsa en ağırlıklı 150'yi al
  const MAX_NODES = 150;
  const sorted = nodes.sort((a, b) => (b.weight + b.edgeCount * 0.2) - (a.weight + a.edgeCount * 0.2));
  const topNodes = sorted.slice(0, MAX_NODES);
  const nodeIds = new Set(topNodes.map(n => n.id));

  const links = scopedEdges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(e => ({
      source: e.from,
      target: e.to,
      relation: e.relation,
      weight: e.weight,
      confidence: e.confidence ?? e.weight ?? 0.5,
      sourceType: e.source_type || '',
      evidenceSource: e.source || 'manual',
      sourceRef: e.source_ref || '',
      evidenceCount: Array.isArray(e.evidence) ? e.evidence.length : 0,
      evidence: Array.isArray(e.evidence) ? e.evidence.slice(0, 2) : [],
      updatedAt: e.updated_at || '',
      createdAt: e.created_at || '',
      sessionId: e.session_id || '',
      workspaceId: e.workspaceId || scope,
    }));

  let memoryNodes = [];
  let memoryLinks = [];
  const memoryMetadata = {
    enabled: false
  };

  if (memory && typeof memory.list === 'function') {
    try {
      const listResult = memory.list({ workspaceId: scope });
      if (listResult && listResult.ok) {
        const activeMemories = listResult.memories || [];
        const topMemories = activeMemories.slice(0, 150);

        memoryNodes = topMemories.map(m => ({
          id: m.memoryId,
          label: getSafeMemoryLabel(m.content),
          type: 'memory',
          workspaceId: m.workspaceId || scope,
          status: m.status || 'active',
          weight: typeof m.metadata?.weight === 'number' ? m.metadata.weight : 1.0,
          metadata: {
            weight: typeof m.metadata?.weight === 'number' ? m.metadata.weight : undefined,
            tags: Array.isArray(m.metadata?.tags)
              ? m.metadata.tags.slice(0, 10).map(t => String(t || '').slice(0, 64))
              : undefined,
          },
        }));

        const memoryNodeIds = new Set(memoryNodes.map(n => n.id));

        let queryLinksAvailable = typeof memory.queryLinks === 'function';
        let allLinks = [];
        if (queryLinksAvailable) {
          const linksResult = memory.queryLinks({ workspaceId: scope });
          if (linksResult && linksResult.ok) {
            allLinks = linksResult.links || [];
          }
        }

        const validLinks = allLinks.filter(l => memoryNodeIds.has(l.fromMemoryId) && memoryNodeIds.has(l.toMemoryId));
        memoryLinks = validLinks.slice(0, 300).map(l => ({
          source: l.fromMemoryId,
          target: l.toMemoryId,
          relation: l.relation,
          type: 'memory-link',
          workspaceId: l.workspaceId || scope,
          weight: typeof l.strength === 'number' ? l.strength : 1.0
        }));

        memoryMetadata.enabled = true;
        memoryMetadata.nodeCount = memoryNodes.length;
        memoryMetadata.linkCount = memoryLinks.length;
        memoryMetadata.source = 'kernel.memory';
      } else {
        memoryMetadata.reason = 'kernel.memory list failed';
      }
    } catch (err) {
      console.error('[graph-data] kernel.memory access error:', err);
      memoryMetadata.reason = 'kernel.memory access error';
    }
  } else {
    memoryMetadata.reason = 'kernel.memory unavailable';
  }

  return {
    nodes: topNodes,
    links,
    memoryNodes,
    memoryLinks,
    metadata: {
      memory: memoryMetadata
    }
  };
}

module.exports = { buildGraphData };
