'use strict';

const { GENESIS_PREVIOUS_HASH } = require('./receipt-chain');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 512;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function normalizeStamp(input) {
  if (!isPlainObject(input)
      || !boundedText(input.sourceId)
      || !boundedText(input.workspaceId)
      || !boundedText(input.schemaFamily)
      || !nonNegativeSafeInteger(input.generation)
      || !nonNegativeSafeInteger(input.receiptCount)
      || typeof input.headHash !== 'string') {
    return null;
  }

  const isGenesis = input.headHash === GENESIS_PREVIOUS_HASH;
  const isReceiptHash = HASH_PATTERN.test(input.headHash);
  if ((!isGenesis && !isReceiptHash)
      || (input.receiptCount === 0 && !isGenesis)
      || (input.receiptCount > 0 && !isReceiptHash)) {
    return null;
  }

  return Object.freeze({
    sourceId: input.sourceId,
    workspaceId: input.workspaceId,
    schemaFamily: input.schemaFamily,
    generation: input.generation,
    receiptCount: input.receiptCount,
    headHash: input.headHash,
  });
}

function stampKey(stamp) {
  return JSON.stringify([
    stamp.sourceId,
    stamp.workspaceId,
    stamp.schemaFamily,
    stamp.generation,
    stamp.receiptCount,
    stamp.headHash,
  ]);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneAndFreeze(value) {
  if (value === null || typeof value !== 'object') return null;
  if (typeof structuredClone !== 'function') return null;
  try {
    const clone = structuredClone(value);
    return deepFreeze(clone);
  } catch (_) {
    return null;
  }
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_) {
    return null;
  }
}

function normalizeOptions(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('validation cache options must be an object');
  const maxEntries = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
  if (!positiveSafeInteger(maxEntries) || !positiveSafeInteger(maxBytes)) {
    throw new RangeError('validation cache bounds must be positive safe integers');
  }
  return { maxEntries, maxBytes };
}

/**
 * Create a process-local cache for already-computed receipt validation results.
 *
 * Cache correctness is stamp-based, never TTL-based: callers must provide a
 * source identity, workspace, schema family, mutation generation, receipt
 * count, and current chain head. Unknown or malformed stamps bypass caching.
 * Stored values are cloned and frozen so a cache hit cannot be mutated by a
 * caller. This module never performs or bypasses canonical validation itself.
 */
function createReceiptValidationCache(options = {}) {
  const { maxEntries, maxBytes } = normalizeOptions(options);
  const entries = new Map();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function clear() {
    entries.clear();
    bytes = 0;
  }

  function invalidateSource(sourceId) {
    if (!boundedText(sourceId)) return false;
    let removed = false;
    for (const [key, entry] of entries) {
      if (entry.stamp.sourceId !== sourceId) continue;
      entries.delete(key);
      bytes -= entry.bytes;
      removed = true;
    }
    return removed;
  }

  function get(inputStamp) {
    const stamp = normalizeStamp(inputStamp);
    if (!stamp) {
      misses += 1;
      return null;
    }
    const key = stampKey(stamp);
    const entry = entries.get(key);
    if (!entry) {
      misses += 1;
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    hits += 1;
    return entry.value;
  }

  function put(inputStamp, value) {
    const stamp = normalizeStamp(inputStamp);
    const cloned = cloneAndFreeze(value);
    if (!stamp || !cloned) return false;
    const valueBytes = serializedBytes(cloned);
    if (valueBytes === null || valueBytes > maxBytes) return false;

    const key = stampKey(stamp);
    const previous = entries.get(key);
    if (previous) {
      entries.delete(key);
      bytes -= previous.bytes;
    }

    entries.set(key, { stamp, value: cloned, bytes: valueBytes });
    bytes += valueBytes;
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldestKey = entries.keys().next().value;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      bytes -= oldest.bytes;
      evictions += 1;
    }
    return entries.has(key);
  }

  function stats() {
    return Object.freeze({
      entries: entries.size,
      bytes,
      maxEntries,
      maxBytes,
      hits,
      misses,
      evictions,
    });
  }

  return Object.freeze({
    clear,
    get,
    invalidateSource,
    put,
    stats,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  GENESIS_PREVIOUS_HASH,
  createReceiptValidationCache,
  normalizeStamp,
};

if (require.main === module) {
  const cache = createReceiptValidationCache();
  process.stdout.write(`${JSON.stringify(cache.stats())}\n`);
}
