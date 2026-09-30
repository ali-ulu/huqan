'use strict';

/**
 * Bounded LRU cache for parsed MemoryStore records.
 * Uses JS Map key ordering to provide O(1) get/set with LRU eviction.
 */
class MemoryRecordCache {
  constructor(maxSize = 2000) {
    this.maxSize = Math.max(10, maxSize);
    this._cache = new Map();
  }

  get(key) {
    if (!this._cache.has(key)) return undefined;
    const value = this._cache.get(key);
    // Mark as most recently used
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._cache.has(key)) {
      this._cache.delete(key);
    } else if (this._cache.size >= this.maxSize) {
      // Evict least recently used (first key in Map)
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) this._cache.delete(oldestKey);
    }
    this._cache.set(key, value);
    return this;
  }

  has(key) {
    return this._cache.has(key);
  }

  delete(key) {
    return this._cache.delete(key);
  }

  clear() {
    this._cache.clear();
  }

  get size() {
    return this._cache.size;
  }
}

module.exports = MemoryRecordCache;
