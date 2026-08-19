'use strict';

const { normalizeWorkspaceId } = require('./memory-store-utils');
const {
  sortByCreatedAtThenId,
  sortByLinkSignature,
  cloneMemoryRecord,
  cloneMemoryLink,
} = require('./memory-record-utils');

const VALID_RELATIONS = ['supersedes', 'contradicts', 'supports', 'references', 'related_to'];
const VALID_DIRECTIONS = ['both', 'outgoing', 'incoming'];

function parseDirection(value) {
  const direction = value === undefined
    ? 'both'
    : typeof value === 'string'
      ? value.trim().toLowerCase()
      : value;
  if (!VALID_DIRECTIONS.includes(direction)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid direction: ${String(value)}` } };
  }
  return { ok: true, direction };
}

/**
 * Link-read context supplied by MemoryStore.
 *
 * @typedef {object} LinkReadContext
 * @property {Array<object>} links - Store-owned link records; never mutated here.
 * @property {Function} findMemory - (memoryId, workspaceId) => memory record | undefined
 * @property {Function} isActiveRecord - record => boolean
 */

function getLinks(context, memoryId) {
  if (!memoryId) return [];
  const id = memoryId.trim();
  return context.links
    .filter((link) => link.fromMemoryId === id || link.toMemoryId === id)
    .sort(sortByLinkSignature)
    .map(cloneMemoryLink);
}

function findLinks(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const relation = typeof opts.relation === 'string' ? opts.relation.trim() : '';
  const directionResult = parseDirection(opts.direction);
  if (!directionResult.ok) return directionResult;
  const { direction } = directionResult;
  const id = memoryId.trim();
  const links = context.links
    .filter((link) => {
      if (link.fromMemoryId !== id && link.toMemoryId !== id) return false;
      if (link.workspaceId !== workspaceId) return false;
      if (relation && link.relation !== relation) return false;
      if (direction === 'outgoing') return link.fromMemoryId === id;
      if (direction === 'incoming') return link.toMemoryId === id;
      return true;
    })
    .sort(sortByLinkSignature);
  return { ok: true, links: links.map(cloneMemoryLink), total: links.length, memoryId: id, workspaceId };
}

function findLinkedMemories(context, memoryId, opts = {}) {
  const linksResult = findLinks(context, memoryId, opts);
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
    const record = context.findMemory(linkedId, workspaceId);
    if (!record || record.workspaceId !== workspaceId) continue;
    if (!includeTombstoned && !context.isActiveRecord(record)) continue;
    memories.push(record);
  }
  memories.sort(sortByCreatedAtThenId);

  return {
    ok: true,
    memoryId: sourceId,
    workspaceId,
    links: linksResult.links.map(cloneMemoryLink),
    memories: memories.map(cloneMemoryRecord),
    total: memories.length,
  };
}

function getBacklinks(context, memoryId) {
  if (!memoryId || typeof memoryId !== 'string') {
    return [];
  }
  const id = memoryId.trim();
  if (!id) return [];
  return getLinks(context, id).filter((link) => link.toMemoryId === id);
}

function traverseLinks(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }

  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const includeTombstoned = opts.includeTombstoned === true;
  const directionResult = parseDirection(opts.direction);
  if (!directionResult.ok) return directionResult;
  const { direction } = directionResult;
  const relation = typeof opts.relation === 'string' ? opts.relation.trim() : '';
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : 1;
  const rootId = memoryId.trim();
  const root = context.findMemory(rootId, workspaceId);
  if (!root || root.workspaceId !== workspaceId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'memory ' + memoryId + ' not found in workspace ' + workspaceId } };
  }
  if (!includeTombstoned && !context.isActiveRecord(root)) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'memory ' + memoryId + ' not found in workspace ' + workspaceId } };
  }

  const visitedNodes = new Set([rootId]);
  const visitedLinks = new Set();
  const nodes = [root];
  const links = [];
  const queue = [{ memoryId: rootId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    const currentLinks = context.links
      .filter((link) => {
        if (link.fromMemoryId !== current.memoryId && link.toMemoryId !== current.memoryId) return false;
        if (link.workspaceId !== workspaceId) return false;
        if (relation && link.relation !== relation) return false;
        if (direction === 'incoming') return link.toMemoryId === current.memoryId;
        if (direction === 'outgoing') return link.fromMemoryId === current.memoryId;
        return true;
      })
      .sort(sortByLinkSignature)
      .map(cloneMemoryLink);
    for (const link of currentLinks) {
      if (visitedLinks.has(link.linkId)) continue;
      visitedLinks.add(link.linkId);
      links.push(link);
      const neighborId = link.fromMemoryId === current.memoryId ? link.toMemoryId : link.fromMemoryId;
      if (visitedNodes.has(neighborId)) continue;
      const neighbor = context.findMemory(neighborId, workspaceId);
      if (!neighbor || neighbor.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !context.isActiveRecord(neighbor)) continue;
      visitedNodes.add(neighborId);
      nodes.push(neighbor);
      queue.push({ memoryId: neighborId, depth: current.depth + 1 });
    }
  }

  links.sort(sortByLinkSignature);

  return {
    ok: true,
    memoryId: rootId,
    workspaceId,
    maxDepth,
    nodes: nodes.map(cloneMemoryRecord),
    links: links.map(cloneMemoryLink),
    totalNodes: nodes.length,
    totalLinks: links.length,
  };
}

function queryLinks(context, opts = {}) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
  }

  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const fromMemoryId = opts.fromMemoryId ? String(opts.fromMemoryId).trim() : null;
  const toMemoryId = opts.toMemoryId ? String(opts.toMemoryId).trim() : null;
  const relation = opts.relation ? String(opts.relation).trim() : null;
  const includeDeleted = opts.includeDeleted === true || opts.includeTombstoned === true;

  if (relation && !VALID_RELATIONS.includes(relation)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid relation: ${relation}` } };
  }

  let offset = 0;
  if (opts.offset !== undefined) {
    offset = Number(opts.offset);
    if (isNaN(offset) || offset < 0) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
    }
  }

  let limit = 100;
  if (opts.limit !== undefined) {
    if (opts.limit === null) {
      limit = Infinity;
    } else {
      limit = Number(opts.limit);
      if (isNaN(limit) || limit < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
      }
      if (limit > 1000) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
      }
    }
  }

  let results = [];
  for (const link of context.links) {
    if (link.workspaceId !== workspaceId) continue;
    if (relation && link.relation !== relation) continue;
    if (fromMemoryId && link.fromMemoryId !== fromMemoryId) continue;
    if (toMemoryId && link.toMemoryId !== toMemoryId) continue;

    const fromMem = context.findMemory(link.fromMemoryId, workspaceId);
    const toMem = context.findMemory(link.toMemoryId, workspaceId);
    if (!fromMem || !toMem) continue;
    if (!includeDeleted && (!context.isActiveRecord(fromMem) || !context.isActiveRecord(toMem))) continue;

    results.push(link);
  }

  results.sort(sortByLinkSignature);

  const total = results.length;
  results = results.slice(offset, offset + limit);

  return {
    ok: true,
    links: results.map(cloneMemoryLink),
    total,
    limit: limit === Infinity ? null : limit,
    offset,
  };
}

function linksForMemory(context, memoryId, opts = {}) {
  if (!memoryId || typeof memoryId !== 'string') {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
  }
  const id = memoryId.trim();
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);
  const directionResult = parseDirection(opts.direction);
  if (!directionResult.ok) return directionResult;
  const { direction } = directionResult;
  const relation = opts.relation ? String(opts.relation).trim() : null;
  const includeDeleted = opts.includeDeleted === true || opts.includeTombstoned === true;

  let results = [];
  for (const link of context.links) {
    if (link.workspaceId !== workspaceId) continue;
    if (relation && link.relation !== relation) continue;

    let match = false;
    if (direction === 'both') {
      match = link.fromMemoryId === id || link.toMemoryId === id;
    } else if (direction === 'outgoing') {
      match = link.fromMemoryId === id;
    } else if (direction === 'incoming') {
      match = link.toMemoryId === id;
    }

    if (!match) continue;

    const fromMem = context.findMemory(link.fromMemoryId, workspaceId);
    const toMem = context.findMemory(link.toMemoryId, workspaceId);
    if (!fromMem || !toMem) continue;
    if (!includeDeleted && (!context.isActiveRecord(fromMem) || !context.isActiveRecord(toMem))) continue;

    results.push(link);
  }

  results.sort(sortByLinkSignature);

  return { ok: true, links: results.map(cloneMemoryLink) };
}

module.exports = {
  getLinks,
  findLinks,
  findLinkedMemories,
  getBacklinks,
  traverseLinks,
  queryLinks,
  linksForMemory,
};

// Keep this module read-only: no exported function mutates the context arrays or records.
