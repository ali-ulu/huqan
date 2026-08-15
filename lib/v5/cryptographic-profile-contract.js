'use strict';

const MAX_MESSAGE_BYTES = 1048576;
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * Traversal budgets (#765).
 *
 * The byte maximum bounds the *result*, and it used to be the only bound: it
 * was checked after the whole value had been recursively serialized. A value
 * that is tiny in bytes but thousands of levels deep therefore exhausted the
 * call stack first, turning a signed-content primitive on the V5 verification
 * path into a synchronous RangeError a caller never asked for.
 *
 * So the work is bounded as it happens, not after: depth caps recursion well
 * below any engine's stack, the node count caps total traversal, and the byte
 * total is accumulated chunk by chunk so an oversized message is refused
 * before the whole string is built rather than after.
 *
 * 64 levels and 100k nodes are far past anything a legitimate signed trust
 * object needs, and both are published on the profile so a producer can see
 * the limit it is signing against.
 */
const MAX_DEPTH = 64;
const MAX_NODES = 100000;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const CRYPTOGRAPHIC_PROFILE_V1 = deepFreeze({
  profileId: 'ed25519-v1',
  signedContentMode: 'canonical-message-bytes',
  canonicalization: 'json-stable-v1',
  textEncoding: 'utf-8',
  messageBytes: {
    minimum: 1,
    maximum: MAX_MESSAGE_BYTES
  },
  canonicalizationLimits: {
    maxDepth: MAX_DEPTH,
    maxNodes: MAX_NODES,
    maxBytes: MAX_MESSAGE_BYTES
  },
  publicKey: {
    representation: 'ed25519-spki-der',
    exactLength: 44
  },
  signature: {
    representation: 'ed25519-raw',
    exactLength: 64
  },
  adapterInputKeys: [
    'algorithm',
    'messageBytes',
    'publicKeySpkiDer',
    'signatureBytes'
  ],
  adapterStates: [
    'valid',
    'invalid',
    'malformed',
    'unsupported'
  ],
  adapterReasons: [
    'signature_invalid',
    'input_malformed',
    'message_malformed',
    'public_key_malformed',
    'signature_malformed',
    'algorithm_unsupported'
  ],
  futureRuntimePrimitive: 'node:crypto'
});

function reject(reason) {
  throw new TypeError('Unsupported json-stable-v1 value: ' + reason);
}

/**
 * A budget overrun is a bounded-input refusal, not an engine failure: it is
 * deterministic, it names which budget ran out, and it carries a code so a
 * verifier can map it onto `malformed` instead of letting it escape.
 */
function exceeded(budgetName) {
  const error = new RangeError('json-stable-v1 input exceeds ' + budgetName);
  error.code = 'JSON_STABLE_V1_LIMIT';
  error.limit = budgetName;
  throw error;
}

function createBudget() {
  return { bytes: 0, nodes: 0 };
}

/** Counts a chunk of output as it is produced, so the byte cap bites early. */
function emit(budget, chunk) {
  budget.bytes += Buffer.byteLength(chunk, 'utf8');
  if (budget.bytes > MAX_MESSAGE_BYTES) {
    exceeded('maximum bytes');
  }
  return chunk;
}

function hasInheritedEnumerableState(value) {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      return true;
    }
  }
  return false;
}

function isPlainJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeArray(value, active, budget, depth) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject('symbol property');
  }

  const ownNames = Object.getOwnPropertyNames(value);
  for (const name of ownNames) {
    if (name === 'length') {
      continue;
    }
    if (!ARRAY_INDEX_PATTERN.test(name) || Number(name) >= value.length) {
      reject('array property');
    }
  }

  active.add(value);
  try {
    emit(budget, '[]');
    const parts = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        reject('sparse array');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        reject('array accessor');
      }
      if (index > 0) {
        emit(budget, ',');
      }
      parts.push(serializeValue(descriptor.value, active, budget, depth + 1));
    }
    return '[' + parts.join(',') + ']';
  } finally {
    active.delete(value);
  }
}

function serializeObject(value, active, budget, depth) {
  if (!isPlainJsonObject(value)) {
    reject('non-plain object');
  }
  if (hasInheritedEnumerableState(value)) {
    reject('inherited enumerable state');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    reject('symbol property');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownNames = Object.getOwnPropertyNames(value);
  for (const name of ownNames) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable) {
      reject('non-enumerable property');
    }
    if (descriptor.get || descriptor.set) {
      reject('accessor property');
    }
    if (name === 'toJSON' && typeof descriptor.value === 'function') {
      reject('custom toJSON');
    }
  }

  active.add(value);
  try {
    emit(budget, '{}');
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key, index) => {
      const encodedKey = JSON.stringify(key);
      emit(budget, index > 0 ? ',' + encodedKey + ':' : encodedKey + ':');
      return encodedKey + ':' + serializeValue(descriptors[key].value, active, budget, depth + 1);
    }).join(',') + '}';
  } finally {
    active.delete(value);
  }
}

function serializeValue(value, active, budget, depth) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    exceeded('maximum nodes');
  }
  if (depth > MAX_DEPTH) {
    exceeded('maximum nesting depth');
  }

  if (value === null) {
    return emit(budget, 'null');
  }
  if (typeof value === 'boolean') {
    return emit(budget, value ? 'true' : 'false');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      reject('non-finite number');
    }
    return emit(budget, Object.is(value, -0) ? '0' : JSON.stringify(value));
  }
  if (typeof value === 'string') {
    return emit(budget, JSON.stringify(value));
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    reject('unsupported primitive');
  }
  if (active.has(value)) {
    reject('cyclic graph');
  }
  if (Array.isArray(value)) {
    return serializeArray(value, active, budget, depth);
  }
  return serializeObject(value, active, budget, depth);
}

function encodeJsonStableV1(value) {
  const serialized = serializeValue(value, new WeakSet(), createBudget(), 0);
  const bytes = Buffer.from(serialized, 'utf8');
  // The incremental accounting above should already have refused an oversized
  // value; this stays as the authoritative check on what is actually returned.
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new RangeError('json-stable-v1 message exceeds maximum bytes');
  }
  return bytes;
}

module.exports = {
  CRYPTOGRAPHIC_PROFILE_V1,
  encodeJsonStableV1
};
