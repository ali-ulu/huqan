'use strict';

// MemoryStore write-side facades moved out of lib/memory-store.js (#2120):
// store, patchMetadata, tombstone, supersede, linkMemories (with the link and
// contradict shorthands) and importPackage, with the store-API builders they
// delegate through. Installed on MemoryStore.prototype by lib/memory-store.js
// with the descriptors they had as class methods; `this` is the MemoryStore
// instance. Persistence stays behind the store port and the transaction seam
// the entry keeps; the delegates receive only the narrow store API each of
// these builders documents.

const { installMemoryStoreMethods } = require('./memory-store-method-install');
// SQLite optional require. The load error is retained (not discarded) so the
// throw site can distinguish "not installed" from "installed but built for a
// different Node ABI" — two failures with different fixes.
const { importPackageEvents, importPackageLinks } = require('./memory-package-import');
const { linkSource } = require('./memory-link-source');
// #328 MS: importPackage validation and admission orchestration delegates to
// memory-package-import-runner.js; this class retains transaction/store ownership.
const { runImportPackage } = require('./memory-package-import-runner');
// #328 MS: store input normalization and event construction delegate to
// memory-store-write.js; this class retains persistence and state mutation.
const { runStore } = require('./memory-store-write');
// #328 MS: supersede delegated to memory-supersede.js (store API documented
// in that module); class method is a one-line delegation.
const { runSupersede } = require('./memory-supersede');
// #328 MS: linkMemories delegates payload construction/validation to
// memory-link-write.js; this store API retains SQLite and cache ownership.
const { runLinkMemories } = require('./memory-link-write');
// #328 MS: patchMetadata payload construction/validation delegates to
// memory-patch-metadata.js; the class retains persistence and store-owned state.
const { runPatchMetadata } = require('./memory-patch-metadata');
// #328 MS: tombstone payload construction/validation delegates to memory-tombstone.js;
// the class retains persistence and store-owned state mutation.
const { runTombstone } = require('./memory-tombstone');

class MemoryStoreWriteMethods {
  _linkWriteStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      findLink: (linkId, workspaceId) => linkSource(store._links).find(workspaceId, linkId),
      defaultTrustPolicyVersion: store._defaultTrustPolicyVersion,
      persist: (opts, payload) => store._storePort.persistLinkMemories(payload),
      appendLink: (link) => { store._links.push(link); },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  /**
   * Store a new memory record.
   * @param {object} input - { content, workspaceId?, metadata?, actor?, trustPolicyVersion?, provenance? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  store(input = {}) {
    return runStore(this._storeStoreApi(), input);
  }

  // #2129: persist lives in the sqlite writer; the delegate gets this narrow write API.
  _storeStoreApi() {
    const store = this;
    return {
      defaultTrustPolicyVersion: store._defaultTrustPolicyVersion,
      persist: (record, event) => store._storePort.persistStoreWrite(record, event),
      remember: (record, event) => {
        Object.freeze(record.content);
        store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
        store._events.push(event);
      },
    };
  }

  /**
   * Patch mutable metadata only. Cannot change content.
   * @param {string} memoryId
   * @param {object} patch - key/value pairs to merge into metadata
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  patchMetadata(memoryId, patch = {}, opts = {}) {
    return runPatchMetadata(this._patchMetadataStoreApi(), memoryId, patch, opts);
  }

  // #328 MS: persistence remains in MemoryStore; the delegate cannot access
  // SQLite handles or mutate store-owned collections directly.
  _patchMetadataStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      persist: (_opts, payload) => store._storePort.persistPatchMetadata(payload),
      applyPatch: (record, nextMetadata, now) => {
        record.metadata = nextMetadata;
        record.updatedAt = now;
      },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  /**
   * Tombstone a memory. Does not physically delete it.
   * @param {string} memoryId
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  tombstone(memoryId, opts = {}) {
    return runTombstone(this._tombstoneStoreApi(), memoryId, opts);
  }

  // #328 MS: persistence remains in MemoryStore; the delegate cannot access
  // SQLite handles or mutate store-owned collections directly.
  _tombstoneStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      persist: (_opts, payload) => store._storePort.persistTombstone(payload),
      markDeleted: (record, now) => {
        record.status = 'deleted';
        record.deletedAt = now;
        record.updatedAt = now;
      },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  /**
   * Supersede a memory with new content. Creates a new memory and a supersedes link.
   * Old memory is marked as superseded. Content is never overwritten.
   * @param {string} oldMemoryId
   * @param {*} newContent
   * @param {object} opts - { actor?, workspaceId?, metadata?, trustPolicyVersion? }
   * @returns {{ ok: boolean, oldMemory?: object, newMemory?: object, link?: object, event?: object, error?: object }}
   */
  supersede(oldMemoryId, newContent, opts = {}) {
    return runSupersede(this._supersedeStoreApi(), oldMemoryId, newContent, opts);
  }

  // #328 MS: store API exposed to lib/memory-supersede.js. Persistence is
  // transactional with rollback on error (mirrors the original inline block);
  // in-memory updates run only after every validation decision succeeds.
  _supersedeStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      makeKey: (workspaceId, memoryId) => store._makeMemoryKey(workspaceId, memoryId),
      remember: (record, key) => { store._memories.set(key, record); },
      appendLinks: (...links) => { store._links.push(...links); },
      appendEvents: (...events) => { store._events.push(...events); },
      persist: (_opts, ops) => store._storePort.persistSupersede(ops),
    };
  }

  link(input = {}) {
    return this.linkMemories(input);
  }

  contradict(memoryId, targetMemoryId, opts = {}) {
    return this.linkMemories({
      fromMemoryId: memoryId,
      toMemoryId: targetMemoryId,
      relation: 'contradicts',
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      trustPolicyVersion: opts.trustPolicyVersion,
      provenance: opts.provenance,
      metadata: opts.metadata,
      confidence: opts.strength,
    });
  }

  /**
   * Link two memories together. Idempotent.
   * @param {object} opts - { fromMemoryId, toMemoryId, relation, workspaceId?, confidence?, metadata?, actor?, provenance? }
   * @returns {{ ok: boolean, link?: object, event?: object, error?: object }}
   */
  linkMemories(opts = {}) {
    return runLinkMemories(this._linkWriteStoreApi(), opts);
  }

  /**
   * Import a memory package into a workspace.
   * @param {object} pkg - { version, schemaVersion, workspaceId, memories, events, links }
   * @param {object} opts - { targetWorkspaceId?, workspaceId?, mode? }
   * @returns {{ ok: boolean, targetWorkspaceId?: string, imported?: { memories: number, events: number, links: number }, skipped?: { memories: number, events: number, links: number }, error?: object }}
   */
  importPackage(pkg, opts = {}) {
    return runImportPackage(this._importPackageStoreApi(), pkg, opts);
  }

  // #328 MS: transaction, persistence, and store-owned collections remain here;
  // the delegate receives only this narrow import API.
  _importPackageStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      snapshot: () => store._snapshotInMemoryState(),
      restore: (snapshot) => store._restoreInMemoryState(snapshot),
      withTransaction: fn => store._storePort.withImportTransaction(fn),
      persistMemory: (record, contentHash) => store._storePort.persistImportMemory(record, contentHash),
      rememberMemory: (record) => {
        Object.freeze(record.content);
        store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
      },
      importEvents: (events, context) => importPackageEvents(store, events, context),
      importLinks: (links, context) => importPackageLinks(store, links, context),
      persistenceError: (err) => store.persistenceError('importPackage', err),
    };
  }
}

function install(MemoryStore) {
  installMemoryStoreMethods(MemoryStore, MemoryStoreWriteMethods);
}

module.exports = { install };
