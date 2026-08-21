'use strict';

/**
 * Event and link admission for `MemoryStore#importPackage`, with the
 * referential check the package-level validator cannot do (#761).
 *
 * `validateMemoryPackage` walks each record through its own field validator,
 * which is per-record by construction: it can say an event is well formed, not
 * that the memory it cites exists. So a syntactically valid package could
 * import an audit history and a relationship graph over memories that were
 * never admitted -- because they were absent from the package, or because
 * their own record failed validation and was skipped a few lines earlier.
 *
 * A package is one graph, so admission is decided against the state the
 * transaction will actually leave behind: `memoryExists` is consulted after
 * the memory loop has run inside the same transaction, so it sees imported
 * records, records that were already present, and records that conflicted
 * (which do exist, with different content) -- but not ones that failed
 * validation.
 *
 * Optional cross-references are deliberately not required to resolve.
 * `relatedMemoryId` and `supersedesMemoryId` point at history that may have
 * been pruned or may live outside the exported slice; requiring them would
 * reject legitimate packages. The identity references -- an event's memoryId
 * and a link's two endpoints -- are what make the record meaningful, and those
 * must resolve.
 */

const {
  validateMemoryEvent,
  validateMemoryLink,
  normalizeMemoryEvent,
  normalizeMemoryLink,
} = require('./memory-schema');

const DANGLING_EVENT = 'event references a memory that will not exist in the target workspace';
const DANGLING_LINK = 'link endpoint references a memory that will not exist in the target workspace';

/**
 * @param {object} ctx
 * @param {string}   ctx.workspaceId
 * @param {function} ctx.memoryExists  - (memoryId) => boolean, post-memory-loop.
 * @param {function} ctx.reject        - records a conflict; throws in strict mode.
 * @param {object}   ctx.imported      - counters, mutated in place.
 * @param {object}   ctx.skipped
 */
function importPackageEvents(store, events, ctx) {
  for (const evt of events) {
    const normalized = normalizeMemoryEvent({
      eventId: evt.eventId,
      eventType: evt.eventType,
      memoryId: evt.memoryId,
      workspaceId: ctx.workspaceId,
      createdAt: evt.createdAt,
      actor: evt.actor,
      provenance: evt.provenance,
      trustPolicyVersion: evt.trustPolicyVersion,
      details: evt.details,
      reviewedAt: evt.reviewedAt || undefined,
      reviewedBy: evt.reviewedBy || undefined,
      relatedMemoryId: evt.relatedMemoryId || undefined,
    });

    const validation = validateMemoryEvent(normalized);
    if (!validation.ok) {
      ctx.reject({ type: 'event', eventId: evt.eventId, reason: validation.errors });
      ctx.skipped.events++;
      continue;
    }

    if (!ctx.memoryExists(normalized.memoryId)) {
      ctx.reject({
        type: 'event',
        eventId: evt.eventId,
        memoryId: normalized.memoryId,
        reason: DANGLING_EVENT,
      });
      ctx.skipped.events++;
      continue;
    }

    if (store._db) {
      store._stmts.insertEvent.run({
        workspace_id: normalized.workspaceId,
        event_id: normalized.eventId,
        event_type: normalized.eventType,
        memory_id: normalized.memoryId,
        actor: normalized.actor,
        details_json: JSON.stringify(normalized.details),
        provenance_json: JSON.stringify(normalized.provenance),
        trust_policy_version: normalized.trustPolicyVersion,
        related_memory_id: normalized.relatedMemoryId || null,
        created_at: normalized.createdAt,
      });
    }

    store._events.push(normalized);
    ctx.imported.events++;
  }
}

function importPackageLinks(store, links, ctx) {
  for (const lnk of links) {
    const normalized = normalizeMemoryLink({
      linkId: lnk.linkId,
      relation: lnk.relation,
      fromMemoryId: lnk.fromMemoryId,
      toMemoryId: lnk.toMemoryId,
      workspaceId: ctx.workspaceId,
      createdAt: lnk.createdAt,
      provenance: lnk.provenance,
      trustPolicyVersion: lnk.trustPolicyVersion,
      strength: lnk.strength,
      metadata: lnk.metadata || {},
    });

    const validation = validateMemoryLink(normalized);
    if (!validation.ok) {
      ctx.reject({ type: 'link', linkId: lnk.linkId, reason: validation.errors });
      ctx.skipped.links++;
      continue;
    }

    const missing = [normalized.fromMemoryId, normalized.toMemoryId].filter(id => !ctx.memoryExists(id));
    if (missing.length > 0) {
      ctx.reject({
        type: 'link',
        linkId: lnk.linkId,
        memoryIds: missing,
        reason: DANGLING_LINK,
      });
      ctx.skipped.links++;
      continue;
    }

    if (store._db) {
      store._stmts.insertLink.run({
        workspace_id: normalized.workspaceId,
        link_id: normalized.linkId,
        relation: normalized.relation,
        from_memory_id: normalized.fromMemoryId,
        to_memory_id: normalized.toMemoryId,
        confidence: normalized.strength,
        provenance_json: JSON.stringify(normalized.provenance),
        trust_policy_version: normalized.trustPolicyVersion,
        created_at: normalized.createdAt,
      });
    }

    store._links.push(normalized);
    ctx.imported.links++;
  }
}

module.exports = {
  importPackageEvents,
  importPackageLinks,
  DANGLING_EVENT,
  DANGLING_LINK,
};
