'use strict';

const SIZE_LIMIT_CODE = 'JSON_UTF8_SIZE_LIMIT_EXCEEDED';
const UNSUPPORTED_VALUE_CODE = 'JSON_UTF8_UNSUPPORTED_VALUE';
const CIRCULAR_REFERENCE_CODE = 'JSON_UTF8_CIRCULAR_REFERENCE';

function byteSizeError(code, message, state) {
  const error = new Error(message);
  error.code = code;
  error.bytes = state.bytes;
  error.maxBytes = state.maxBytes;
  return error;
}

function addBytes(state, amount) {
  state.bytes += amount;
  if (state.bytes > state.maxBytes) {
    throw byteSizeError(
      SIZE_LIMIT_CODE,
      `JSON UTF-8 size exceeds ${state.maxBytes} bytes`,
      state,
    );
  }
}

function countJsonString(value, state) {
  addBytes(state, 1);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      addBytes(state, 2);
      continue;
    }
    if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      addBytes(state, 2);
      continue;
    }
    if (code <= 0x1f) {
      addBytes(state, 6);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        addBytes(state, 4);
        i += 1;
      } else {
        addBytes(state, 6);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      addBytes(state, 6);
      continue;
    }
    if (code <= 0x7f) addBytes(state, 1);
    else if (code <= 0x7ff) addBytes(state, 2);
    else addBytes(state, 3);
  }
  addBytes(state, 1);
}

function countJsonValue(value, state, ancestors) {
  if (value === null) {
    addBytes(state, 4);
    return;
  }

  const type = typeof value;
  if (type === 'string') {
    countJsonString(value, state);
    return;
  }
  if (type === 'boolean') {
    addBytes(state, value ? 4 : 5);
    return;
  }
  if (type === 'number') {
    const serialized = Number.isFinite(value) ? String(value) : 'null';
    addBytes(state, serialized.length);
    return;
  }
  if (type !== 'object') {
    throw byteSizeError(
      UNSUPPORTED_VALUE_CODE,
      `unsupported JSON value type: ${type}`,
      state,
    );
  }

  if (ancestors.has(value)) {
    throw byteSizeError(CIRCULAR_REFERENCE_CODE, 'circular JSON reference', state);
  }
  if (Object.hasOwn(value, 'toJSON')) {
    throw byteSizeError(UNSUPPORTED_VALUE_CODE, 'custom toJSON is not supported', state);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      addBytes(state, 1);
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) addBytes(state, 1);
        if (!Object.hasOwn(value, i)) {
          throw byteSizeError(UNSUPPORTED_VALUE_CODE, 'sparse arrays are not supported', state);
        }
        countJsonValue(value[i], state, ancestors);
      }
      addBytes(state, 1);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw byteSizeError(UNSUPPORTED_VALUE_CODE, 'non-plain objects are not supported', state);
    }

    const keys = Object.keys(value);
    addBytes(state, 1);
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) addBytes(state, 1);
      const key = keys[i];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw byteSizeError(UNSUPPORTED_VALUE_CODE, 'accessor properties are not supported', state);
      }
      countJsonString(key, state);
      addBytes(state, 1);
      countJsonValue(descriptor.value, state, ancestors);
    }
    addBytes(state, 1);
  } finally {
    ancestors.delete(value);
  }
}

function measureJsonUtf8Bytes(value, options = {}) {
  const maxBytes = options.maxBytes === undefined
    ? Number.MAX_SAFE_INTEGER
    : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('measureJsonUtf8Bytes requires maxBytes to be a non-negative safe integer');
  }
  const state = { bytes: 0, maxBytes };
  countJsonValue(value, state, new WeakSet());
  return state.bytes;
}

module.exports = {
  SIZE_LIMIT_CODE,
  UNSUPPORTED_VALUE_CODE,
  CIRCULAR_REFERENCE_CODE,
  measureJsonUtf8Bytes,
};
