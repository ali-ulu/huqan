'use strict';

// MemoryStore read-side facades moved out of lib/memory-store.js (#2120):
// record, event, link and temporal reads plus the query engine and package
// export facades, with the read-context builders they delegate through.
// Installed on MemoryStore.prototype by lib/memory-store.js with the
// descriptors they had as class methods; `this` is the MemoryStore instance.
// The store keeps handle and collection ownership; these methods only read
// through the narrow contexts each delegate module documents.

const { installMemoryStoreMethods } = require('./memory-store-method-install');
// #328 MS: query/sort/pagination delegated to memory-query-engine.js; class
// methods are one-line delegations (context interface documented there).
const { runQuery, runMemoriesBetween } = require('./memory-query-engine');
// #328 MS: temporal reads delegate to memory-temporal.js through a read-only context.
const { runTemporalQuery } = require('./memory-temporal');
// #328 MS: link-read methods delegate to memory-link-read.js; the delegate
// receives a read-only context and has no access to mutation or SQLite state.
const {
  getLinks: readLinks,
  findLinks: readFindLinks,
  findLinkedMemories: readFindLinkedMemories,
  getBacklinks: readBacklinks,
  traverseLinks: readTraverseLinks,
  queryLinks: readQueryLinks,
  linksForMemory: readLinksForMemory,
} = require('./memory-link-read');
// #328 MS: event reads delegate to memory-event-read.js through a read-only context.
const { runEventsForMemory, runTimeline, runGetEvents, runHistory } = require('./memory-event-read');
// #328 MS: record lookup reads delegate to memory-record-read.js through a read-only context.
const {
  getMemory: readGetMemory,
  listMemories: readListMemories,
  findById: readFindById,
  findByContentHash: readFindByContentHash,
  findBySourceRef: readFindBySourceRef,
  findByKind: readFindByKind,
  findByStatus: readFindByStatus,
} = require('./memory-record-read');
// #328 MS: package export delegates read-only collection projection and
// validation to memory-package-export.js.
const { runExportPackage } = require('./memory-package-export');

class MemoryStoreReadMethods {
  _linkReadContext() {
    return {
      links: this._links,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
      isActiveRecord: (record) => this._isActiveRecord(record),
    };
  }

  _eventReadContext() {
    return {
      events: this._events,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
    };
  }

  _recordReadContext() {
    return {
      memories: this._memories,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
      isActiveRecord: (record) => this._isActiveRecord(record),
    };
  }

  _temporalReadContext() {
    return { memories: this._memories };
  }

  /**
   * List memories for a workspace.
   * @param {object} opts - { workspaceId?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories: object[], total: number }}
   */
  list(opts = {}) {
    return readListMemories(this._recordReadContext(), opts);
  }

  /**
   * Get a single memory by id.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId? }
   * @returns {{ ok: boolean, memory?: object, error?: object }}
   */
  get(memoryId, opts = {}) {
    return readGetMemory(this._recordReadContext(), memoryId, opts);
  }

  /**
   * Get all events for a memory.
   * @param {string} memoryId
   * @param {object} opts
   * @returns {object[]}
   */
  getEvents(memoryId, opts = {}) { return runGetEvents(this._eventReadContext(), memoryId, opts); }

  /**
   * Get all links for a memory in one workspace.
   * @param {string} memoryId
   * @param {object} opts
   * @returns {object[]}
   */
  getLinks(memoryId, opts = {}) { return readLinks(this._linkReadContext(), memoryId, opts); }

  _queryTemporalMemories(opts = {}) {
    return runTemporalQuery(this._temporalReadContext(), opts);
  }

  findById(memoryId, opts = {}) {
    return readFindById(this._recordReadContext(), memoryId, opts);
  }

  findByContentHash(contentHash, opts = {}) {
    return readFindByContentHash(this._recordReadContext(), contentHash, opts);
  }

  findBySourceRef(sourceRef, opts = {}) {
    return readFindBySourceRef(this._recordReadContext(), sourceRef, opts);
  }

  findByKind(kind, opts = {}) {
    return readFindByKind(this._recordReadContext(), kind, opts);
  }

  findByStatus(status, opts = {}) {
    return readFindByStatus(this._recordReadContext(), status, opts);
  }

  findLinks(memoryId, opts = {}) {
    return readFindLinks(this._linkReadContext(), memoryId, opts);
  }

  findLinkedMemories(memoryId, opts = {}) {
    return readFindLinkedMemories(this._linkReadContext(), memoryId, opts);
  }

  history(memoryId, opts = {}) {
    return runHistory(this._eventReadContext(), memoryId, opts);
  }

  getBacklinks(memoryId, opts = {}) {
    return readBacklinks(this._linkReadContext(), memoryId, opts);
  }

  traverseLinks(memoryId, opts = {}) {
    return readTraverseLinks(this._linkReadContext(), memoryId, opts);
  }

  since(timestamp, opts = {}) {
    return this._queryTemporalMemories({ ...opts, since: timestamp });
  }

  before(timestamp, opts = {}) {
    return this._queryTemporalMemories({ ...opts, before: timestamp });
  }

  between(start, end, opts = {}) {
    return this._queryTemporalMemories({ ...opts, between: [start, end] });
  }

  /**
   * Bellek üzerinde detaylı sorgulama yapar.
   * @param {object} opts Sorgu seçenekleri ve filtreler
   * @returns {{ ok: boolean, memories?: object[], total?: number, limit?: number|null, offset?: number, error?: object }}
   */
  query(opts = {}) {
    return runQuery({ memories: this._memories, isActiveRecord: this._isActiveRecord.bind(this) }, opts);
  }

  /**
   * Bellek sorgulama için temiz alias.
   */
  search(opts = {}) {
    return this.query(opts);
  }

  /**
   * Query memory links.
   * @param {object} opts - { workspaceId?, fromMemoryId?, toMemoryId?, relation?, includeDeleted?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, links?: object[], total?: number, error?: object }}
   */
  queryLinks(opts = {}) {
    return readQueryLinks(this._linkReadContext(), opts);
  }

  /**
   * Get links for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, direction?, relation?, includeDeleted?, includeTombstoned? }
   * @returns {{ ok: boolean, links?: object[], error?: object }}
   */
  linksForMemory(memoryId, opts = {}) {
    return readLinksForMemory(this._linkReadContext(), memoryId, opts);
  }

  /**
   * Get events for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  eventsForMemory(memoryId, opts = {}) {
    return runEventsForMemory(this._eventReadContext(), memoryId, opts);
  }

  /**
   * Get workspace event timeline.
   * @param {object} opts - { workspaceId?, actor?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  timeline(opts = {}) {
    return runTimeline(this._eventReadContext(), opts);
  }

  /**
   * Get memories created between start and end timestamps.
   * @param {string} start - ISO start timestamp
   * @param {string} end - ISO end timestamp
   * @param {object} opts - { workspaceId?, includeDeleted?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories?: object[], total?: number, error?: object }}
   */
  memoriesBetween(start, end, opts = {}) {
    return runMemoriesBetween({ memories: this._memories, isActiveRecord: this._isActiveRecord.bind(this) }, start, end, opts);
  }

  /**
   * Export a memory package for a workspace.
   * @param {object} opts - { workspaceId, includeTombstoned? }
   * @returns {{ ok: boolean, package?: object, error?: object }}
   */
  exportPackage(opts = {}) {
    return runExportPackage({
      memories: this._memories,
      events: this._events,
      links: this._links,
    }, opts);
  }
}

function install(MemoryStore) {
  installMemoryStoreMethods(MemoryStore, MemoryStoreReadMethods);
}

module.exports = { install };
