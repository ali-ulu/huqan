'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MEMORY_LINK_RELATIONS,
  normalizeMemoryEvent,
  normalizeMemoryLink,
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
  validateMemoryPackage,
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

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeContentHash(content, kind = '') {
  const payload = stableStringify({ kind: kind || '', content: deepClone(content) });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
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

function toPublicMemory(record) {
  return deepClone(record);
}

function toPublicLink(link) {
  return deepClone(link);
}

function toPublicEvent(event) {
  return deepClone(event);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function groupByWorkspace(records) {
  const grouped = new Map();
  for (const record of records) {
    const workspaceId = normalizeWorkspaceId(record.workspaceId);
    if (!grouped.has(workspaceId)) {
      grouped.set(workspaceId, []);
    }
    grouped.get(workspaceId).push(record);
  }
  return grouped;
}

function sortByCreatedAtThenId(left, right, idField = 'memoryId') {
  const leftTime = typeof left.createdAt === 'string' ? left.createdAt : '';
  const rightTime = typeof right.createdAt === 'string' ? right.createdAt : '';
  const timeComparison = leftTime.localeCompare(rightTime);
  if (timeComparison !== 0) return timeComparison;
  return String(left[idField] || '').localeCompare(String(right[idField] || ''));
}

function isPersistedPackage(value) {
  return value && typeof value === 'object' && Array.isArray(value.memories) && Array.isArray(value.events) && Array.isArray(value.links);
}

class MemoryStore {
  constructor(opts = {}) {
    this._memories = new Map();   // memoryId -> record
    this._events = [];            // append-only event log
    this._links = [];             // memory links
    this._defaultTrustPolicyVersion = opts.trustPolicyVersion || '1.0.0';
    this._memoryPath = typeof opts.memoryPath === 'string' && opts.memoryPath.trim() ? opts.memoryPath.trim() : '';
    this._dbPath = typeof opts.dbPath === 'string' && opts.dbPath.trim() ? opts.dbPath.trim() : '';
    this._useSQLite = opts.useSQLite !== false;
    this._autoPersist = opts.autoPersist !== false && Boolean(this._memoryPath || this._dbPath);
    this._storageMode = null;
    this._db = null;
    this._stmts = null;

    this._initStorage();
    if (opts.autoLoad !== false) {
      this.load();
    }
  }

  _initStorage() {
    if (this._dbPath && this._useSQLite) {
      try {
        const Database = require('better-sqlite3');
        ensureDirForFile(this._dbPath);
        this._db = new Database(this._dbPath);
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS memory_packages (
            workspace_id TEXT PRIMARY KEY,
            package_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT ''
          );
        `);
        this._stmts = {
          upsertPackage: this._db.prepare(`
            INSERT INTO memory_packages (workspace_id, package_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
              package_json = excluded.package_json,
              updated_at = excluded.updated_at
          `),
          allPackages: this._db.prepare('SELECT workspace_id, package_json FROM memory_packages ORDER BY workspace_id ASC'),
          deleteAllPackages: this._db.prepare('DELETE FROM memory_packages'),
        };
        this._storageMode = 'sqlite';
        return;
      } catch (error) {
        this._db = null;
        this._stmts = null;
        this._storageMode = null;
        console.error('[MemoryStore] SQLite init failed, falling back to JSON:', error.message);
      }
    }

    if (this._memoryPath) {
      this._storageMode = 'json';
    }
  }

  _workspacePackages() {
    const groupedMemories = groupByWorkspace(this._memories.values());
    const groupedEvents = groupByWorkspace(this._events);
    const groupedLinks = groupByWorkspace(this._links);
    const workspaceIds = new Set([
      ...groupedMemories.keys(),
      ...groupedEvents.keys(),
      ...groupedLinks.keys(),
    ]);
    const packages = [];
    for (const workspaceId of Array.from(workspaceIds).sort()) {
      packages.push({
        version: this._defaultTrustPolicyVersion,
        workspaceId,
        memories: (groupedMemories.get(workspaceId) || []).map(toPublicMemory),
        events: (groupedEvents.get(workspaceId) || []).map(toPublicEvent),
        links: (groupedLinks.get(workspaceId) || []).map(toPublicLink),
      });
    }
    return packages;
  }

  _applyPackage(pkg) {
    const validation = validateMemoryPackage(pkg);
    if (!validation.ok) {
      return validation;
    }

    for (const record of pkg.memories || []) {
      const normalized = normalizeMemoryRecord(record);
      this._memories.set(normalized.memoryId, normalized);
    }
    for (const event of pkg.events || []) {
      const normalized = normalizeMemoryEvent(event);
      this._events.push(normalized);
    }
    for (const link of pkg.links || []) {
      const normalized = normalizeMemoryLink(link);
      this._links.push(normalized);
    }
    return validation;
  }

  _serializeSnapshot() {
    const workspaces = {};
    for (const pkg of this._workspacePackages()) {
      workspaces[pkg.workspaceId] = pkg;
    }
    return {
      version: this._defaultTrustPolicyVersion,
      workspaces,
    };
  }

  _persistIfEnabled() {
    if (!this._autoPersist) return { ok: true, skipped: true };
    try {
      this.save();
      return { ok: true };
    } catch (error) {
      console.error('[MemoryStore] persist failed:', error.message);
      return { ok: false, error };
    }
  }

  save() {
    if (!this._storageMode) {
      return { ok: true, skipped: true };
    }

    const snapshot = this._serializeSnapshot();
    if (this._storageMode === 'sqlite') {
      ensureDirForFile(this._dbPath);
      const packages = Object.values(snapshot.workspaces);
      const tx = this._db.transaction(() => {
        this._stmts.deleteAllPackages.run();
        for (const pkg of packages) {
          this._stmts.upsertPackage.run(pkg.workspaceId, JSON.stringify(pkg), new Date().toISOString());
        }
      });
      tx();
      return { ok: true, backend: 'sqlite', workspaceCount: packages.length };
    }

    ensureDirForFile(this._memoryPath);
    fs.writeFileSync(this._memoryPath, JSON.stringify(snapshot, null, 2));
    return { ok: true, backend: 'json', workspaceCount: Object.keys(snapshot.workspaces).length };
  }

  load() {
    this._memories.clear();
    this._events = [];
    this._links = [];

    if (!this._storageMode) {
      return { ok: true, skipped: true };
    }

    const packages = [];
    if (this._storageMode === 'sqlite') {
      if (!this._db || !this._stmts) {
        return { ok: true, loaded: 0, backend: 'sqlite', skipped: true };
      }
      const rows = this._stmts.allPackages.all();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.package_json || '{}');
          if (isPersistedPackage(parsed)) {
            packages.push(parsed);
          }
        } catch (_) {}
      }
    } else if (this._memoryPath && fs.existsSync(this._memoryPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this._memoryPath, 'utf8'));
        if (Array.isArray(parsed.workspaces)) {
          packages.push(...parsed.workspaces.filter(isPersistedPackage));
        } else if (parsed.workspaces && typeof parsed.workspaces === 'object') {
          packages.push(...Object.values(parsed.workspaces).filter(isPersistedPackage));
        } else if (isPersistedPackage(parsed)) {
          packages.push(parsed);
        }
      } catch (error) {
        return { ok: false, error: { code: 'LOAD_ERROR', message: `failed to load memory store: ${error.message}` } };
      }
    }

    let loaded = 0;
    for (const pkg of packages) {
      const validation = this._applyPackage(pkg);
      if (validation.ok) {
        loaded++;
      }
    }
    return { ok: true, loaded, backend: this._storageMode };
  }

  close() {
    if (this._db) {
      try {
        this._db.close();
      } catch (_) {}
    }
    this._db = null;
    this._stmts = null;
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
    if (typeof input.content === 'string' && !input.content.trim()) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'content must not be empty' } };
    }

    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const trustPolicyVersion = input.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const actor = input.actor || 'system';
    const content = deepClone(input.content);
    const metadata = deepClone(input.metadata || {});
    const provenance = deepClone(input.provenance) || makeProvenance(actor, workspaceId, trustPolicyVersion);
    provenance.workspaceId = normalizeWorkspaceId(provenance.workspaceId || workspaceId);
    provenance.trustPolicyVersion = provenance.trustPolicyVersion || trustPolicyVersion;
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    const contentHash = makeContentHash(content, kind);
    const memoryId = crypto.createHash('sha256').update(`${workspaceId}|${contentHash}`).digest('hex').slice(0, 16);
    const existing = this._memories.get(memoryId);
    if (existing && existing.workspaceId === workspaceId && existing.contentHash === contentHash) {
      return { ok: true, memory: toPublicMemory(existing), created: false, event: null };
    }
    const now = new Date().toISOString();

    const record = normalizeMemoryRecord({
      memoryId,
      workspaceId,
      content,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      metadata,
      contentHash,
      ...(kind ? { kind } : {}),
    });

    const validation = validateMemoryRecord(record);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory record failed validation', details: validation.errors } };
    }

    this._memories.set(memoryId, record);

    const event = normalizeMemoryEvent({
      eventId: generateEventId(),
      eventType: 'CREATED',
      memoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'store' },
    });
    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      this._memories.delete(memoryId);
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory event failed validation', details: eventValidation.errors } };
    }
    this._events.push(event);
    this._persistIfEnabled();

    return { ok: true, memory: toPublicMemory(record), created: true, event: toPublicEvent(event) };
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

    return { ok: true, memories: results.map(toPublicMemory), total };
  }

  _collectMemories(opts = {}, predicate = () => true) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const results = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && record.status === 'deleted') continue;
      if (!predicate(record)) continue;
      results.push(record);
    }
    results.sort(sortByCreatedAtThenId);
    return results;
  }

  _collectLinks(opts = {}, predicate = () => true) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const results = [];
    for (const link of this._links) {
      if (link.workspaceId !== workspaceId) continue;
      if (!predicate(link)) continue;
      results.push(link);
    }
    results.sort(sortByCreatedAtThenId);
    return results;
  }

  _collectEvents(opts = {}, predicate = () => true) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const results = [];
    for (const event of this._events) {
      if (event.workspaceId !== workspaceId) continue;
      if (!predicate(event)) continue;
      results.push(event);
    }
    results.sort(sortByCreatedAtThenId);
    return results;
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

    return { ok: true, memory: toPublicMemory(record) };
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

    return { ok: true, memories: memories.map(toPublicMemory), total: memories.length, query: needle };
  }

  /**
   * Find a memory by id within a workspace. Defaults to the default workspace.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   */
  findById(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const record = this._memories.get(memoryId.trim());
    if (!record || record.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
    }
    if (!opts.includeTombstoned && record.status === 'deleted') {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
    }

    return { ok: true, memory: toPublicMemory(record) };
  }

  /**
   * Find memories with an exact content hash match in a workspace.
   * @param {string} contentHash
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   */
  findByContentHash(contentHash, opts = {}) {
    const needle = typeof contentHash === 'string' ? contentHash.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'contentHash is required' } };
    }
    const memories = this._collectMemories(opts, (record) => record.contentHash === needle);
    return { ok: true, memories: memories.map(toPublicMemory), total: memories.length, contentHash: needle };
  }

  /**
   * Find memories with an exact sourceRef match in provenance.
   * @param {string} sourceRef
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   */
  findBySourceRef(sourceRef, opts = {}) {
    const needle = typeof sourceRef === 'string' ? sourceRef.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sourceRef is required' } };
    }
    const memories = this._collectMemories(opts, (record) => record.provenance && record.provenance.sourceRef === needle);
    return { ok: true, memories: memories.map(toPublicMemory), total: memories.length, sourceRef: needle };
  }

  /**
   * Find memories by kind within a workspace.
   * @param {string} kind
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   */
  findByKind(kind, opts = {}) {
    const needle = typeof kind === 'string' ? kind.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'kind is required' } };
    }
    const memories = this._collectMemories(opts, (record) => record.kind === needle);
    return { ok: true, memories: memories.map(toPublicMemory), total: memories.length, kind: needle };
  }

  /**
   * Find memories by status within a workspace.
   * @param {string} status
   * @param {object} opts - { workspaceId?, includeTombstoned? }
   */
  findByStatus(status, opts = {}) {
    const needle = typeof status === 'string' ? status.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'status is required' } };
    }
    const memories = this._collectMemories({ ...opts, includeTombstoned: true }, (record) => record.status === needle);
    return { ok: true, memories: memories.map(toPublicMemory), total: memories.length, status: needle };
  }

  /**
   * Find links attached to a memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, relation?, direction? }
   */
  findLinks(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const relation = typeof opts.relation === 'string' ? opts.relation.trim() : '';
    const direction = typeof opts.direction === 'string' ? opts.direction.trim().toLowerCase() : 'both';
    const id = memoryId.trim();
    const links = this._collectLinks({ workspaceId }, (link) => {
      if (relation && link.relation !== relation) return false;
      if (direction === 'outgoing') return link.fromMemoryId === id;
      if (direction === 'incoming') return link.toMemoryId === id;
      return link.fromMemoryId === id || link.toMemoryId === id;
    });
    return { ok: true, links: links.map(toPublicLink), total: links.length, memoryId: id, workspaceId };
  }

  /**
   * Find the memories linked to a memory. Returns both the memories and the links used.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, relation?, direction?, includeTombstoned? }
   */
  findLinkedMemories(memoryId, opts = {}) {
    const linksResult = this.findLinks(memoryId, opts);
    if (!linksResult.ok) return linksResult;

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const sourceId = memoryId.trim();
    const linkedIds = new Set();
    for (const link of linksResult.links) {
      if (link.fromMemoryId === sourceId) linkedIds.add(link.toMemoryId);
      if (link.toMemoryId === sourceId) linkedIds.add(link.fromMemoryId);
    }

    const memories = [];
    for (const linkedId of linkedIds) {
      const record = this._memories.get(linkedId);
      if (!record || record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && record.status === 'deleted') continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);

    return {
      ok: true,
      memoryId: sourceId,
      workspaceId,
      links: linksResult.links,
      memories: memories.map(toPublicMemory),
      total: memories.length,
    };
  }

  /**
   * Return the event history for a memory within a workspace.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId? }
   */
  history(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const id = memoryId.trim();
    const events = this._collectEvents({ workspaceId }, (event) => event.memoryId === id || event.relatedMemoryId === id);
    return { ok: true, memoryId: id, workspaceId, events: events.map(toPublicEvent), total: events.length };
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
    this._persistIfEnabled();

    return { ok: true, memory: toPublicMemory(record), event: toPublicEvent(event) };
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
    const provenance = deepClone(input.provenance) || makeProvenance(actor, workspaceId, trustPolicyVersion);
    provenance.workspaceId = workspaceId;
    provenance.trustPolicyVersion = provenance.trustPolicyVersion || trustPolicyVersion;
    const now = new Date().toISOString();

    const existing = this._links.find((item) =>
      item.relation === relation &&
      item.fromMemoryId === fromMemoryId &&
      item.toMemoryId === toMemoryId &&
      item.workspaceId === workspaceId
    );
    if (existing) {
      return { ok: true, link: toPublicLink(existing), deduped: true };
    }

    const link = normalizeMemoryLink({
      linkId: generateLinkId(),
      relation,
      fromMemoryId,
      toMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      strength: typeof input.strength === 'number' ? input.strength : undefined,
      metadata: deepClone(input.metadata || {}),
    });
    const linkValidation = validateMemoryLink(link);
    if (!linkValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory link failed validation', details: linkValidation.errors } };
    }
    this._links.push(link);

    const event = normalizeMemoryEvent({
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
    });
    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      this._links.pop();
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory event failed validation', details: eventValidation.errors } };
    }
    this._events.push(event);
    this._persistIfEnabled();

    return { ok: true, link: toPublicLink(link), event: toPublicEvent(event) };
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
    const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const provenance = deepClone(opts.provenance) || makeProvenance(actor, record.workspaceId, trustPolicyVersion);
    provenance.workspaceId = record.workspaceId;
    provenance.trustPolicyVersion = provenance.trustPolicyVersion || trustPolicyVersion;

    const updated = normalizeMemoryRecord({
      ...deepClone(record),
      status: 'deleted',
      deletedAt: now,
      updatedAt: now,
      provenance,
      trustPolicyVersion,
    });
    const validation = validateMemoryRecord(updated);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'tombstoned memory failed validation', details: validation.errors } };
    }

    this._memories.set(record.memoryId, updated);

    const event = normalizeMemoryEvent({
      eventId: generateEventId(),
      eventType: 'TOMBSTONE',
      memoryId,
      workspaceId: updated.workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'tombstone' },
    });
    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      this._memories.set(record.memoryId, record);
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory event failed validation', details: eventValidation.errors } };
    }
    this._events.push(event);
    this._persistIfEnabled();

    return { ok: true, memory: toPublicMemory(updated), event: toPublicEvent(event) };
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
    const trustPolicyVersion = opts.trustPolicyVersion || oldRecord.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const workspaceId = oldRecord.workspaceId;
    const provenance = deepClone(opts.provenance) || makeProvenance(actor, workspaceId, trustPolicyVersion);
    provenance.workspaceId = workspaceId;
    provenance.trustPolicyVersion = provenance.trustPolicyVersion || trustPolicyVersion;
    const kind = typeof opts.kind === 'string' ? opts.kind.trim() : '';
    const newContentClone = deepClone(newContent);
    const newContentHash = makeContentHash(newContentClone, kind);
    const newMemoryId = crypto.createHash('sha256').update(`${workspaceId}|${newContentHash}`).digest('hex').slice(0, 16);

    // Create new memory record
    const newRecord = normalizeMemoryRecord({
      memoryId: newMemoryId,
      workspaceId,
      content: newContentClone,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      supersedesMemoryId: oldMemoryId,
      metadata: deepClone(opts.metadata || {}),
      contentHash: newContentHash,
      ...(kind ? { kind } : {}),
    });

    const validation = validateMemoryRecord(newRecord);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'new memory record failed validation', details: validation.errors } };
    }

    this._memories.set(newMemoryId, newRecord);

    // Mark old memory as superseded (status change only, content untouched)
    oldRecord.status = 'superseded';
    oldRecord.updatedAt = now;

    // Create supersedes link
    const link = normalizeMemoryLink({
      linkId: generateLinkId(),
      relation: 'supersedes',
      fromMemoryId: newMemoryId,
      toMemoryId: oldMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
    });
    const linkValidation = validateMemoryLink(link);
    if (!linkValidation.ok) {
      this._memories.delete(newMemoryId);
      this._memories.set(oldMemoryId.trim(), oldRecord);
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory link failed validation', details: linkValidation.errors } };
    }
    this._links.push(link);

    // Create event
    const event = normalizeMemoryEvent({
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
    });
    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      this._links.pop();
      this._memories.delete(newMemoryId);
      this._memories.set(oldMemoryId.trim(), oldRecord);
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory event failed validation', details: eventValidation.errors } };
    }
    this._events.push(event);
    this._persistIfEnabled();

    return {
      ok: true,
      oldMemory: toPublicMemory(oldRecord),
      newMemory: toPublicMemory(newRecord),
      link: toPublicLink(link),
      event: toPublicEvent(event),
    };
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
    return this._events.filter(e => e.memoryId === memoryId.trim()).map(toPublicEvent);
  }

  /**
   * Get all links for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getLinks(memoryId) {
    if (!memoryId) return [];
    const id = memoryId.trim();
    return this._links.filter(l => l.fromMemoryId === id || l.toMemoryId === id).map(toPublicLink);
  }
}

module.exports = MemoryStore;
