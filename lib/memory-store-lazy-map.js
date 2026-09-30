'use strict';

const { loadMemoryRecordFromRow } = require('./memory-store-row-codec');

/**
 * LazyMemoryMap: transparent Map replacement that loads records on-demand
 * from SQLite when not already present in the bounded record cache.
 * Preserves the Map interface for all existing delegates, callers, and tests.
 */
class LazyMemoryMap extends Map {
  constructor(store) {
    super();
    this._store = store;
  }

  get(key) {
    if (this._store._recordCache.has(key)) {
      return this._store._recordCache.get(key);
    }
    if (super.has(key)) {
      return super.get(key);
    }
    if (!this._store._db || !this._store._stmts?.selectMemory) {
      return undefined;
    }
    const strKey = String(key || '');
    const idx = strKey.indexOf(':');
    if (idx === -1) return undefined;
    const workspaceId = strKey.slice(0, idx);
    const memoryId = strKey.slice(idx + 1);
    if (!workspaceId || !memoryId) return undefined;

    const row = this._store._stmts.selectMemory.get(workspaceId, memoryId);
    if (!row) return undefined;

    const record = loadMemoryRecordFromRow(this._store, row);
    if (!record) return undefined;

    this._store._recordCache.set(key, record);
    super.set(key, record);
    return record;
  }

  has(key) {
    if (this._store._recordCache.has(key) || super.has(key)) return true;
    if (!this._store._db || !this._store._stmts?.hasMemory) return false;
    const strKey = String(key || '');
    const idx = strKey.indexOf(':');
    if (idx === -1) return false;
    const workspaceId = strKey.slice(0, idx);
    const memoryId = strKey.slice(idx + 1);
    if (!workspaceId || !memoryId) return false;
    const found = this._store._stmts.hasMemory.get(workspaceId, memoryId);
    return !!found;
  }

  set(key, record) {
    this._store._recordCache.set(key, record);
    super.set(key, record);
    return this;
  }

  delete(key) {
    this._store._recordCache.delete(key);
    return super.delete(key);
  }

  clear() {
    this._store._recordCache.clear();
    super.clear();
  }

  get size() {
    if (this._store._db && this._store._stmts?.countMemories) {
      try {
        return this._store._stmts.countMemories.get().count;
      } catch (_) {
        return super.size;
      }
    }
    return super.size;
  }

  *values() {
    if (this._store._db && this._store._stmts?.allMemories) {
      for (const row of this._store._stmts.allMemories.iterate()) {
        const key = this._store.makeMemoryKey(row.workspace_id, row.memory_id);
        const cached = this._store._recordCache.get(key) || super.get(key);
        if (cached) {
          yield cached;
          continue;
        }
        const record = loadMemoryRecordFromRow(this._store, row);
        if (record) {
          this._store._recordCache.set(key, record);
          super.set(key, record);
          yield record;
        }
      }
    } else {
      yield* super.values();
    }
  }

  *entries() {
    if (this._store._db && this._store._stmts?.allMemories) {
      for (const row of this._store._stmts.allMemories.iterate()) {
        const key = this._store.makeMemoryKey(row.workspace_id, row.memory_id);
        const cached = this._store._recordCache.get(key) || super.get(key);
        if (cached) {
          yield [key, cached];
          continue;
        }
        const record = loadMemoryRecordFromRow(this._store, row);
        if (record) {
          this._store._recordCache.set(key, record);
          super.set(key, record);
          yield [key, record];
        }
      }
    } else {
      yield* super.entries();
    }
  }

  *keys() {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) {
      callback.call(thisArg, value, key, this);
    }
  }
}

module.exports = LazyMemoryMap;
