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
const { eventSource } = require('./memory-event-source');
const { linkSource } = require('./memory-link-source');

/*
 * Events and links already present in the target workspace are skipped.
 *
 * The memory loop skips a record whose content already matches, in every mode,
 * but events and links had no such check: re-importing one package doubled the
 * audit history and duplicated every link, so `findLinkedMemories` could return
 * the same neighbour twice and edge counts inflated. On SQLite it was worse --
 * a UNIQUE constraint on event_id/link_id turns the second import into a
 * thrown constraint error that rolls back the whole transaction. Neither
 * outcome is idempotent. The check reads through eventSource()/linkSource(),
 * so on SQLite it is one indexed lookup, not a scan (#3208).
 */

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

    if (eventSource(store._events).has(normalized.workspaceId, normalized.eventId)) {
      ctx.skipped.events++;
      continue;
    }

    // #2906: the row write (SQLite only) goes through MemoryStorePort.
    store._storePort.persistImportEvent(normalized);

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

    if (linkSource(store._links).find(normalized.workspaceId, normalized.linkId)) {
      ctx.skipped.links++;
      continue;
    }

    store._storePort.persistImportLink(normalized);

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
