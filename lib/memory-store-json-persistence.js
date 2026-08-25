'use strict';

const fs = require('node:fs');
const {
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
  normalizeMemoryRecord,
  normalizeMemoryEvent,
  normalizeMemoryLink,
} = require('./memory-schema');
const { normalizeWorkspaceId } = require('./memory-store-utils');

const MEMORY_STORE_JSON_VERSION = '1.0.0';

function atomicWriteFileSync(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function invalidPersistenceFile(message, details) {
  const error = new Error(message);
  error.code = 'MEMORY_STORE_JSON_INVALID';
  if (details !== undefined) error.details = details;
  return error;
}

function memoryKey(record) {
  return `${normalizeWorkspaceId(record.workspaceId)}:${String(record.memoryId || '').trim()}`;
}

function requireArray(data, field) {
  if (!Array.isArray(data[field])) {
    throw invalidPersistenceFile(`MemoryStore JSON field ${field} must be an array.`);
  }
  return data[field];
}

function validateAndNormalizeRecords(data) {
  const records = [];
  const keys = new Set();
  for (const [index, raw] of requireArray(data, 'memories').entries()) {
    const record = normalizeMemoryRecord(raw);
    const validation = validateMemoryRecord(record);
    if (!validation.ok) {
      throw invalidPersistenceFile(`Invalid memory record at memories[${index}].`, validation.errors);
    }
    const key = memoryKey(record);
    if (keys.has(key)) {
      throw invalidPersistenceFile(`Duplicate memory record at memories[${index}].`, { memoryId: record.memoryId, workspaceId: record.workspaceId });
    }
    keys.add(key);
    Object.freeze(record.content);
    records.push(record);
  }
  return { records, keys };
}

function validateAndNormalizeEvents(data, memoryKeys) {
  const events = [];
  const ids = new Set();
  for (const [index, raw] of requireArray(data, 'events').entries()) {
    const event = normalizeMemoryEvent(raw);
    const validation = validateMemoryEvent(event);
    if (!validation.ok) {
      throw invalidPersistenceFile(`Invalid memory event at events[${index}].`, validation.errors);
    }
    const idKey = `${event.workspaceId}:${event.eventId}`;
    if (ids.has(idKey)) {
      throw invalidPersistenceFile(`Duplicate memory event at events[${index}].`, { eventId: event.eventId, workspaceId: event.workspaceId });
    }
    if (!memoryKeys.has(`${event.workspaceId}:${event.memoryId}`)) {
      throw invalidPersistenceFile(`Memory event at events[${index}] references a missing memory.`, {
        eventId: event.eventId,
        memoryId: event.memoryId,
        workspaceId: event.workspaceId,
      });
    }
    ids.add(idKey);
    events.push(event);
  }
  return events;
}

function validateAndNormalizeLinks(data, memoryKeys) {
  const links = [];
  const ids = new Set();
  for (const [index, raw] of requireArray(data, 'links').entries()) {
    const link = normalizeMemoryLink(raw);
    const validation = validateMemoryLink(link);
    if (!validation.ok) {
      throw invalidPersistenceFile(`Invalid memory link at links[${index}].`, validation.errors);
    }
    const idKey = `${link.workspaceId}:${link.linkId}`;
    if (ids.has(idKey)) {
      throw invalidPersistenceFile(`Duplicate memory link at links[${index}].`, { linkId: link.linkId, workspaceId: link.workspaceId });
    }
    const missing = [link.fromMemoryId, link.toMemoryId]
      .filter((memoryId) => !memoryKeys.has(`${link.workspaceId}:${memoryId}`));
    if (missing.length > 0) {
      throw invalidPersistenceFile(`Memory link at links[${index}] references a missing memory.`, {
        linkId: link.linkId,
        memoryIds: missing,
        workspaceId: link.workspaceId,
      });
    }
    ids.add(idKey);
    links.push(link);
  }
  return links;
}

function loadJsonMemoryStore(filePath) {
  if (!fs.existsSync(filePath)) {
    return { memories: [], events: [], links: [] };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw invalidPersistenceFile(`MemoryStore JSON could not be parsed: ${cause.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidPersistenceFile('MemoryStore JSON root must be an object.');
  }
  if (data.version !== undefined && String(data.version) !== MEMORY_STORE_JSON_VERSION) {
    throw invalidPersistenceFile(`Unsupported MemoryStore JSON version: ${data.version}`);
  }

  const { records, keys } = validateAndNormalizeRecords(data);
  return {
    memories: records,
    events: validateAndNormalizeEvents(data, keys),
    links: validateAndNormalizeLinks(data, keys),
  };
}

function saveJsonMemoryStore(filePath, state) {
  const payload = {
    version: MEMORY_STORE_JSON_VERSION,
    memories: state.memories,
    events: state.events,
    links: state.links,
  };
  atomicWriteFileSync(filePath, JSON.stringify(payload));
}

function currentJsonState(store) {
  return {
    memories: Array.from(store._memories.values()),
    events: store._events,
    links: store._links,
  };
}

function persistJsonState(store, operation, state) {
  try {
    saveJsonMemoryStore(store._jsonPath, state);
    return undefined;
  } catch (err) {
    return store._persistenceError(operation, err);
  }
}

function persistJsonStore(store, record, event) {
  return persistJsonState(store, 'store', {
    memories: [...store._memories.values(), record],
    events: [...store._events, event],
    links: store._links,
  });
}

function persistJsonLink(store, payload) {
  const { link, event } = payload;
  return persistJsonState(store, 'linkMemories', {
    memories: Array.from(store._memories.values()),
    events: [...store._events, event],
    links: [...store._links, link],
  });
}

function persistJsonPatch(store, payload) {
  const { record, event, nextMetadata, now } = payload;
  return persistJsonState(store, 'patchMetadata', {
    memories: Array.from(store._memories.values()).map((current) => current === record
      ? { ...record, metadata: nextMetadata, updatedAt: now }
      : current),
    events: [...store._events, event],
    links: store._links,
  });
}

function persistJsonTombstone(store, payload) {
  const { record, event, now } = payload;
  return persistJsonState(store, 'tombstone', {
    memories: Array.from(store._memories.values()).map((current) => current === record
      ? { ...record, status: 'deleted', deletedAt: now, updatedAt: now }
      : current),
    events: [...store._events, event],
    links: store._links,
  });
}

function persistJsonSupersede(store, ops) {
  const { newRecord, oldRecord, link, event, oldMemoryUpdateEvent } = ops;
  const supersededAt = oldMemoryUpdateEvent.createdAt;
  return persistJsonState(store, 'supersede', {
    memories: [
      ...Array.from(store._memories.values()).map((current) => current === oldRecord
        ? { ...oldRecord, status: 'superseded', updatedAt: supersededAt }
        : current),
      newRecord,
    ],
    events: [...store._events, event, oldMemoryUpdateEvent],
    links: [...store._links, link],
  });
}

function persistJsonMutation(store, operation, payload) {
  if (!store._jsonPath) return undefined;
  if (operation === 'store') return persistJsonStore(store, payload.record, payload.event);
  if (operation === 'linkMemories') return persistJsonLink(store, payload);
  if (operation === 'patchMetadata') return persistJsonPatch(store, payload);
  if (operation === 'tombstone') return persistJsonTombstone(store, payload);
  if (operation === 'supersede') return persistJsonSupersede(store, payload);
  return persistJsonState(store, operation, currentJsonState(store));
}

function saveJsonStore(store, report) {
  const persistence = persistJsonState(store, 'save', currentJsonState(store));
  return persistence && persistence.ok === false ? persistence : report(null, store._jsonPath);
}

function loadJsonStore(store, report) {
  try {
    applyJsonMemoryStore(store, loadJsonMemoryStore(store._jsonPath));
    return report(null, store._jsonPath, store._memories.size);
  } catch (err) {
    return store._persistenceError('load', err);
  }
}

function withJsonTransaction(store, fn) {
  const result = store._withTransaction(fn);
  if (!store._db && store._jsonPath) {
    const persistence = persistJsonState(store, 'importPackage', currentJsonState(store));
    if (persistence && persistence.ok === false) {
      const error = new Error(persistence.error.message);
      Object.assign(error, persistence.error);
      throw error;
    }
  }
  return result;
}

function applyJsonMemoryStore(store, state) {
  store._memories = new Map(
    state.memories.map((record) => [store._makeMemoryKey(record.workspaceId, record.memoryId), record]),
  );
  store._events = state.events;
  store._links = state.links;
}

module.exports = {
  MEMORY_STORE_JSON_VERSION,
  applyJsonMemoryStore,
  currentJsonState,
  loadJsonMemoryStore,
  persistJsonLink,
  persistJsonMutation,
  persistJsonPatch,
  persistJsonStore,
  persistJsonState,
  persistJsonSupersede,
  persistJsonTombstone,
  saveJsonStore,
  loadJsonStore,
  withJsonTransaction,
};
