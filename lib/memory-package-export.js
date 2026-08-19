// Delegated from lib/memory-store.js (MemoryStore.exportPackage) by #328 MS.
// The delegate is intentionally read-only: it receives the three in-memory
// collections, never a store receiver, SQLite state, or mutation functions.
const { validateMemoryPackage } = require('./memory-schema');
const { deepClone } = require('./memory-record-utils');
const { normalizeWorkspaceId } = require('./memory-store-utils');

/**
 * @typedef {object} PackageExportContext
 * @property {Map<string, object>} memories - live memory records, read-only here
 * @property {object[]} events - append-only event records, read-only here
 * @property {object[]} links - memory link records, read-only here
 */

/**
 * Export a validated memory package for one workspace.
 *
 * The intermediate package intentionally aliases live record fields. It is
 * deep-cloned exactly once at the return boundary, preserving the original
 * ownership and performance contract without exposing store state to callers.
 *
 * @param {PackageExportContext} context
 * @param {object} opts - { workspaceId, includeTombstoned? }
 * @returns {{ ok: boolean, package?: object, error?: object }}
 */
function runExportPackage(context, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;

  const memories = [];
  const events = [];
  const links = [];

  for (const record of context.memories.values()) {
    if (record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && record.status === 'deleted') continue;
    memories.push({
      memoryId: record.memoryId,
      workspaceId: record.workspaceId,
      content: record.content,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt || undefined,
      deletedAt: record.deletedAt || undefined,
      supersedesMemoryId: record.supersedesMemoryId || undefined,
      status: record.status,
      metadata: record.metadata,
      provenance: record.provenance,
      trustPolicyVersion: record.trustPolicyVersion,
    });
  }

  for (const event of context.events) {
    if (event.workspaceId !== workspaceId) continue;
    events.push({
      eventId: event.eventId,
      eventType: event.eventType,
      memoryId: event.memoryId,
      workspaceId: event.workspaceId,
      createdAt: event.createdAt,
      actor: event.actor,
      provenance: event.provenance,
      trustPolicyVersion: event.trustPolicyVersion,
      details: event.details,
      reviewedAt: event.reviewedAt || undefined,
      reviewedBy: event.reviewedBy || undefined,
      relatedMemoryId: event.relatedMemoryId || undefined,
    });
  }

  for (const link of context.links) {
    if (link.workspaceId !== workspaceId) continue;
    links.push({
      linkId: link.linkId,
      relation: link.relation,
      fromMemoryId: link.fromMemoryId,
      toMemoryId: link.toMemoryId,
      workspaceId: link.workspaceId,
      createdAt: link.createdAt,
      provenance: link.provenance,
      trustPolicyVersion: link.trustPolicyVersion,
      strength: link.strength,
      metadata: link.metadata || undefined,
    });
  }

  const pkg = {
    version: '1.0.0',
    schemaVersion: 'memory-package-v1',
    workspaceId,
    memories,
    events,
    links,
  };

  const validation = validateMemoryPackage(pkg);
  if (!validation.ok) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'exported package failed validation', details: validation.errors } };
  }

  return { ok: true, package: deepClone(pkg) };
}

module.exports = { runExportPackage };
