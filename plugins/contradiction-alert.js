const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  if (input && typeof input.idea === 'string') return input.idea.trim();
  return '';
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function classifyConflict(incomingRelation, existingRelation, incomingObject, existingObject) {
  if (
    (incomingRelation === 'değil' && existingRelation === 'tür' && incomingObject === existingObject) ||
    (incomingRelation === 'tür' && existingRelation === 'değil' && incomingObject === existingObject)
  ) {
    return 'direct';
  }

  if (
    incomingRelation === existingRelation &&
    incomingRelation === 'yapabilir' &&
    incomingObject !== existingObject
  ) {
    return 'strategic';
  }

  if (incomingRelation !== existingRelation && incomingObject !== existingObject) {
    return 'indirect';
  }

  return null;
}

function parseIncoming(kernel, predicate) {
  const raw = String(predicate || '').trim();
  const asciiNeg = raw.match(/^(.+?)\s+degil(dir)?$/i);
  if (asciiNeg) {
    return { relation: 'değil', object: asciiNeg[1].trim() };
  }
  if (typeof kernel._parsePredicate === 'function') {
    return kernel._parsePredicate(raw);
  }
  return null;
}

// REFACTOR-4D: migrate private `kernel.graph?._nodes` access to the public
// `graph.getNodes(workspaceId)` API. `extractFacts` accepts either an object
// (uses Object.keys) or an array; both `_nodes` and `getNodes('default')`
// return `{id: node}` for the default workspace, so the observable behavior
// (which node IDs are considered "known" during fact extraction) is
// preserved. Using the public API keeps contradiction-alert off private
// graph state. See docs/refactor/refactor-4d-contract-acceptance.md AC-5.5
// and docs/refactor/decision-4d-graph-workspace-contract.md (Bölüm 4.2.3
// — contradiction-alert graph snapshot target, AUDIT_PENDING resolved:
// pre-migration behavior was default-workspace via `getEdges(subject)`
// default-arg, so the migration target is `getNodes('default')`).
function contradictionAlertKnownNodes(kernel) {
  if (!kernel) return {};
  if (kernel.graph && typeof kernel.graph.getNodes === 'function') {
    return kernel.graph.getNodes('default');
  }
  return kernel.graph?._nodes || {};
}

function createContradictionAlertPlugin() {
  return {
    name: 'contradiction-alert',
    version: '0.1.0',
    requires: ['graph', 'temporal'],
    optional: ['llm', 'evidenceRanking'],
    capabilities: [
      {
        name: 'contradictionAlert',
        command: 'celiski',
        description: 'Checks whether a new idea conflicts with older ideas.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      const facts = typeof kernel.extractFacts === 'function' ? kernel.extractFacts(text, contradictionAlertKnownNodes(kernel)) || [] : [];

      const conflicts = [];
      for (const fact of facts) {
        const subject = fact.subject;
        const parsed = parseIncoming(kernel, fact.predicate);

        if (!subject || !parsed) continue;
        const incomingRelation = parsed.relation;
        const incomingObject = parsed.object;
        const edges = kernel.graph && typeof kernel.graph.getEdges === 'function'
          ? kernel.graph.getEdges(subject) || []
          : [];

        for (const edge of edges) {
          const conflictType = classifyConflict(incomingRelation, edge.relation, incomingObject, edge.to);
          if (!conflictType) continue;

          const entry = {
            subject,
            incoming: { relation: incomingRelation, object: incomingObject },
            existing: { relation: edge.relation, object: edge.to },
            conflictType,
            source: edge.source || 'graph',
          };

          if (kernel.hasCapability && kernel.hasCapability('temporal')) {
            const createdAt = toIso(edge.created_at) || toIso(edge.created);
            entry.created_at = createdAt;
            if (createdAt) {
              const deltaMs = Date.now() - new Date(createdAt).getTime();
              entry.age_ms = Math.max(0, deltaMs);
            }
          }

          if (kernel.hasCapability && kernel.hasCapability('evidenceRanking')) {
            const evidenceType = edge.evidenceType || 'chat_memory';
            const base = edge.confidence ?? edge.weight ?? 0.5;
            entry.evidenceType = evidenceType;
            entry.adjustedConfidence = adjustedConfidence(base, evidenceType);
          }

          conflicts.push(entry);
        }
      }

      const conflictType = conflicts.length > 0
        ? (conflicts.find(c => c.conflictType === 'direct')?.conflictType
          || conflicts.find(c => c.conflictType === 'strategic')?.conflictType
          || conflicts[0].conflictType)
        : null;

      const evidenceQuality = (kernel.hasCapability && kernel.hasCapability('evidenceRanking') && conflicts.length > 0)
        ? Number((conflicts.reduce((sum, c) => sum + (c.adjustedConfidence || 0), 0) / conflicts.length).toFixed(3))
        : null;

      return {
        ok: true,
        plugin: 'contradiction-alert',
        capability: opts.capability?.name || 'contradictionAlert',
        data: {
          newThought: text,
          conflictingThoughts: conflicts,
          conflictType,
          evidenceQuality,
        },
      };
    },
  };
}

module.exports = createContradictionAlertPlugin();
module.exports.create = createContradictionAlertPlugin;
