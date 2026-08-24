const {
  normalizeWorkspaceId,
  nodeStorageKey,
  nowIso,
  deepClone,
  cloneNodeRecord,
  normalizeNodeLabel,
} = require('./graph-record-utils');

/**
 * Owns Graph.addNode input normalization and in-memory record construction.
 * The Graph store API retains SQLite statement access and collection ownership.
 */
function addNode(storeApi, id, label, provenance = null, opts = {}) {
  // Decided before any persist call, so both backends see the same value
  // (#1027).
  const nodeLabel = normalizeNodeLabel(label, id);
  const now = Date.now();
  const isoNow = nowIso();
  const hasExplicitProvenance = provenance && typeof provenance === 'object';
  const workspaceId = normalizeWorkspaceId(opts.workspaceId || provenance?.workspaceId);
  const storageKey = nodeStorageKey(id, workspaceId);
  const persisted = storeApi.readPersisted(id, workspaceId);
  const existing = persisted.existing;
  const createdAt = existing && existing.created_at ? existing.created_at : isoNow;
  const existingProvenance = existing ? JSON.parse(existing.provenance || 'null') : null;
  const nextProvenance = hasExplicitProvenance ? provenance : existingProvenance;
  const current = storeApi.get(storageKey);
  const hasCurrent = current && normalizeWorkspaceId(current.workspaceId) === workspaceId;
  const currentWeight = hasCurrent ? current.weight : existing?.weight;
  const nextWeight = Number.isFinite(currentWeight)
    ? Math.min(1, currentWeight + 0.1)
    : 0.5;

  if (persisted.enabled) {
    storeApi.persist({
      id,
      workspaceId,
      label: nodeLabel,
      weight: nextWeight,
      created: now,
      createdAt,
      lastAccessed: now,
      lastSeen: isoNow,
      vector: existing ? existing.vector : '{}',
      provenance: JSON.stringify(nextProvenance ?? null),
    });
  }

  if (hasCurrent) {
    current.label = nodeLabel;
    current.workspaceId = workspaceId;
    current.weight = nextWeight;
    current.lastAccessed = now;
    current.lastSeen = isoNow;
    current.last_seen = isoNow;
    if (hasExplicitProvenance) current.provenance = deepClone(provenance);
  } else {
    storeApi.set(storageKey, persisted.enabled
      ? {
          id, label: nodeLabel, tags: [], vector: {}, weight: nextWeight, workspaceId,
          created: now, created_at: createdAt, lastAccessed: now,
          lastSeen: isoNow, last_seen: isoNow,
          provenance: nextProvenance ?? null,
        }
      : {
          id, label: nodeLabel, tags: [], vector: {}, weight: nextWeight, workspaceId,
          created: now, created_at: isoNow, lastAccessed: now,
          lastSeen: isoNow, last_seen: isoNow,
          provenance: hasExplicitProvenance ? provenance : null,
        });
  }
  return cloneNodeRecord(storeApi.get(storageKey));
}

module.exports = { addNode };
