'use strict';

const crypto = require('crypto');
const {
  MEMORY_LINK_RELATIONS,
  validateMemoryRecord,
  normalizeMemoryRecord,
  MEMORY_STATUSES,
} = require('./memory-schema');

/**
 * AXIOM Memory Store — deterministic, in-memory storage layer.
 *
 * PR-M2 scope: API/service layer only.
 * Persistence (SQLite) is deferred to PR-M3.
 *
 * Core laws enforced:
 *   1. Memory content is immutable.
 *   2. Content changes require supersede (new memory + link).
 *   3. Deletion creates a tombstone, never physically removes.
 *   4. Every memory is workspace-scoped.
 *   5. memoryId generation is deterministic (content hash).
 */

function generateMemoryId(content, workspaceId, createdAt) {
  const payload = JSON.stringify({ content, workspaceId, createdAt });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function generateEventId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function generateLinkId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function normalizeWorkspaceId(value) {
  return String(value || 'default').trim() || 'default';
}

function makeProvenance(actor, workspaceId, trustPolicyVersion) {
  const now = new Date().toISOString();
  return {
    provenanceId: generateEventId(),
    sourceRef: 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: 'memory-api',
    actor: actor || 'system',
    timestamp: now,
    workspaceId: normalizeWorkspaceId(workspaceId),
    trustPolicyVersion: trustPolicyVersion || '1.0.0',
    confidence: 1.0,
  };
}

class MemoryStore {
  constructor(opts = {}) {
    this._memories = new Map();   // memoryId -> record
    this._events = [];            // append-only event log
    this._links = [];             // memory links
    this._defaultTrustPolicyVersion = opts.trustPolicyVersion || '1.0.0';
  }

  /**
   * Store a new memory record.
   * @param {object} input - { content, workspaceId?, metadata?, actor?, trustPolicyVersion?, provenance? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  store(input = {}) {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'input must be an object' } };
    }
    if (input.content === undefined || input.content === null) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'content is required' } };
    }

    const now = new Date().toISOString();
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const trustPolicyVersion = input.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const actor = input.actor || 'system';
    const provenance = input.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
    const memoryId = generateMemoryId(input.content, workspaceId, now);

    const record = normalizeMemoryRecord({
      memoryId,
      workspaceId,
      content: JSON.parse(JSON.stringify(input.content)),
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      metadata: input.metadata || {},
    });

    const validation = validateMemoryRecord(record);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory record failed validation', details: validation.errors } };
    }

    // Freeze content to enforce immutability
    Object.freeze(record.content);
    this._memories.set(memoryId, record);

    const event = {
      eventId: generateEventId(),
      eventType: 'CREATED',
      memoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'store' },
    };
    this._events.push(event);

    return { ok: true, memory: record, event };
  }

  /**
   * List memories for a workspace.
   * @param {object} opts - { workspaceId?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories: object[], total: number }}
   */
  list(opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : Infinity;
    const offset = typeof opts.offset === 'number' && opts.offset >= 0 ? opts.offset : 0;

    let results = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && record.status === 'deleted') continue;
      results.push(record);
    }

    // Deterministic order: by createdAt ascending, then memoryId ascending
    results.sort((a, b) => {
      const t = a.createdAt.localeCompare(b.createdAt);
      return t !== 0 ? t : a.memoryId.localeCompare(b.memoryId);
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return { ok: true, memories: results, total };
  }

  /**
   * Get a single memory by id.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId? }
   * @returns {{ ok: boolean, memory?: object, error?: object }}
   */
  get(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const record = this._memories.get(memoryId.trim());
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (opts.workspaceId) {
      const wid = normalizeWorkspaceId(opts.workspaceId);
      if (record.workspaceId !== wid) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
      }
    }

    return { ok: true, memory: record };
  }

  /**
   * Search memories by text within content/metadata for a workspace.
   * @param {string} query
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   * @returns {{ ok: boolean, memories?: object[], total?: number, query?: string, error?: object }}
   */
  search(query, opts = {}) {
    const needle = typeof query === 'string'
      ? query.trim()
      : typeof opts.query === 'string'
        ? opts.query.trim()
        : '';

    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'query is required' } };
    }

    const listed = this.list(opts);
    if (!listed.ok) return listed;

    const lowered = needle.toLowerCase();
    const memories = listed.memories.filter((record) => {
      const haystack = JSON.stringify({
        content: record.content,
        metadata: record.metadata || {},
      }).toLowerCase();
      return haystack.includes(lowered);
    });

    return { ok: true, memories, total: memories.length, query: needle };
  }

  /**
   * Patch mutable metadata only. Cannot change content.
   * @param {string} memoryId
   * @param {object} patch - key/value pairs to merge into metadata
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  patchMetadata(memoryId, patch = {}, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'patch must be a plain object' } };
    }

    // Guard: cannot overwrite content via metadata patch
    if ('content' in patch) {
      return { ok: false, error: { code: 'IMMUTABLE_CONTENT', message: 'content cannot be changed via patchMetadata; use supersede instead' } };
    }

    const record = this._memories.get(memoryId.trim());
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (opts.workspaceId) {
      const wid = normalizeWorkspaceId(opts.workspaceId);
      if (record.workspaceId !== wid) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
      }
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';

    // Merge patch into metadata
    record.metadata = { ...(record.metadata || {}), ...JSON.parse(JSON.stringify(patch)) };
    record.updatedAt = now;

    const event = {
      eventId: generateEventId(),
      eventType: 'UPDATED',
      memoryId,
      workspaceId: record.workspaceId,
      createdAt: now,
      actor,
      provenance: record.provenance,
      trustPolicyVersion: record.trustPolicyVersion,
      details: { action: 'patchMetadata', patch },
    };
    this._events.push(event);

    return { ok: true, memory: record, event };
  }

  /**
   * Create a typed relation between two memories in the same workspace.
   * @param {object} input
   * @returns {{ ok: boolean, link?: object, event?: object, error?: object }}
   */
  link(input = {}) {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'input must be an object' } };
    }

    const fromMemoryId = typeof input.fromMemoryId === 'string' ? input.fromMemoryId.trim() : '';
    const toMemoryId = typeof input.toMemoryId === 'string' ? input.toMemoryId.trim() : '';
    const relation = typeof input.relation === 'string' ? input.relation.trim() : '';
    const workspaceId = normalizeWorkspaceId(input.workspaceId);

    if (!fromMemoryId || !toMemoryId || !relation) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'fromMemoryId, toMemoryId and relation are required' } };
    }
    if (!MEMORY_LINK_RELATIONS.includes(relation)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'relation is not a supported memory relation' } };
    }

    const fromRecord = this._memories.get(fromMemoryId);
    const toRecord = this._memories.get(toMemoryId);
    if (!fromRecord || !toRecord) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'linked memories must exist' } };
    }
    if (fromRecord.workspaceId !== workspaceId || toRecord.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `linked memories not found in workspace ${workspaceId}` } };
    }
    if (fromRecord.status === 'deleted' || toRecord.status === 'deleted') {
      return { ok: false, error: { code: 'INVALID_STATE', message: 'cannot link tombstoned memories' } };
    }

    const actor = input.actor || 'system';
    const trustPolicyVersion = input.trustPolicyVersion || fromRecord.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const provenance = input.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
    const now = new Date().toISOString();

    const existing = this._links.find((item) =>
      item.relation === relation &&
      item.fromMemoryId === fromMemoryId &&
      item.toMemoryId === toMemoryId &&
      item.workspaceId === workspaceId
    );
    if (existing) {
      return { ok: true, link: existing, deduped: true };
    }

    const link = {
      linkId: generateLinkId(),
      relation,
      fromMemoryId,
      toMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      strength: typeof input.strength === 'number' ? input.strength : undefined,
      metadata: input.metadata || {},
    };
    this._links.push(link);

    const event = {
      eventId: generateEventId(),
      eventType: 'LINKED',
      memoryId: fromMemoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'link', relation, toMemoryId },
      relatedMemoryId: toMemoryId,
    };
    this._events.push(event);

    return { ok: true, link, event };
  }

  /**
   * Tombstone a memory. Does not physically delete it.
   * @param {string} memoryId
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  tombstone(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const record = this._memories.get(memoryId.trim());
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (opts.workspaceId) {
      const wid = normalizeWorkspaceId(opts.workspaceId);
      if (record.workspaceId !== wid) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
      }
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';

    record.status = 'deleted';
    record.deletedAt = now;
    record.updatedAt = now;

    const event = {
      eventId: generateEventId(),
      eventType: 'TOMBSTONE',
      memoryId,
      workspaceId: record.workspaceId,
      createdAt: now,
      actor,
      provenance: record.provenance,
      trustPolicyVersion: record.trustPolicyVersion,
      details: { action: 'tombstone' },
    };
    this._events.push(event);

    return { ok: true, memory: record, event };
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
    if (!oldMemoryId || typeof oldMemoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'oldMemoryId is required' } };
    }
    if (newContent === undefined || newContent === null) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'newContent is required' } };
    }

    const oldRecord = this._memories.get(oldMemoryId.trim());
    if (!oldRecord) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found` } };
    }

    if (opts.workspaceId) {
      const wid = normalizeWorkspaceId(opts.workspaceId);
      if (oldRecord.workspaceId !== wid) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found in workspace ${wid}` } };
      }
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';
    const trustPolicyVersion = opts.trustPolicyVersion || oldRecord.trustPolicyVersion;
    const workspaceId = oldRecord.workspaceId;
    const provenance = makeProvenance(actor, workspaceId, trustPolicyVersion);
    const newMemoryId = generateMemoryId(newContent, workspaceId, now);

    // Create new memory record
    const newRecord = normalizeMemoryRecord({
      memoryId: newMemoryId,
      workspaceId,
      content: JSON.parse(JSON.stringify(newContent)),
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      supersedesMemoryId: oldMemoryId,
      metadata: opts.metadata || {},
    });

    const validation = validateMemoryRecord(newRecord);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'new memory record failed validation', details: validation.errors } };
    }

    Object.freeze(newRecord.content);
    this._memories.set(newMemoryId, newRecord);

    // Mark old memory as superseded (status change only, content untouched)
    oldRecord.status = 'superseded';
    oldRecord.updatedAt = now;

    // Create supersedes link
    const link = {
      linkId: generateLinkId(),
      relation: 'supersedes',
      fromMemoryId: newMemoryId,
      toMemoryId: oldMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
    };
    this._links.push(link);

    // Create event
    const event = {
      eventId: generateEventId(),
      eventType: 'CREATED',
      memoryId: newMemoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'supersede', supersedesMemoryId: oldMemoryId },
      relatedMemoryId: oldMemoryId,
    };
    this._events.push(event);

    return { ok: true, oldMemory: oldRecord, newMemory: newRecord, link, event };
  }

  /**
   * Create a contradiction relation between two memories.
   * @param {string} memoryId
   * @param {string} targetMemoryId
   * @param {object} opts
   * @returns {{ ok: boolean, link?: object, event?: object, error?: object }}
   */
  contradict(memoryId, targetMemoryId, opts = {}) {
    return this.link({
      fromMemoryId: memoryId,
      toMemoryId: targetMemoryId,
      relation: 'contradicts',
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      trustPolicyVersion: opts.trustPolicyVersion,
      provenance: opts.provenance,
      metadata: opts.metadata,
      strength: opts.strength,
    });
  }

  /**
   * Get all events for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getEvents(memoryId) {
    if (!memoryId) return [];
    return this._events.filter(e => e.memoryId === memoryId.trim());
  }

  /**
   * Get all links for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getLinks(memoryId) {
    if (!memoryId) return [];
    const id = memoryId.trim();
    return this._links.filter(l => l.fromMemoryId === id || l.toMemoryId === id);
  }
}

module.exports = MemoryStore;
