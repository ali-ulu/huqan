'use strict';

const { isValidIsoDate, normalizeWorkspaceId } = require('./memory-store-utils');

function sortByCreatedAtThenId(left, right, idField = 'memoryId') {
  const leftTime = typeof left.createdAt === 'string' ? left.createdAt : '';
  const rightTime = typeof right.createdAt === 'string' ? right.createdAt : '';
  const timeComparison = leftTime.localeCompare(rightTime);
  if (timeComparison !== 0) return timeComparison;
  return String(left[idField] || '').localeCompare(String(right[idField] || ''));
}

function sortByLinkSignature(left, right) {
  const workspaceComparison = normalizeWorkspaceId(left.workspaceId).localeCompare(normalizeWorkspaceId(right.workspaceId));
  if (workspaceComparison !== 0) return workspaceComparison;

  const fromComparison = String(left.fromMemoryId || '').localeCompare(String(right.fromMemoryId || ''));
  if (fromComparison !== 0) return fromComparison;

  const toComparison = String(left.toMemoryId || '').localeCompare(String(right.toMemoryId || ''));
  if (toComparison !== 0) return toComparison;

  const relationComparison = String(left.relation || '').localeCompare(String(right.relation || ''));
  if (relationComparison !== 0) return relationComparison;

  const createdComparison = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  if (createdComparison !== 0) return createdComparison;

  return String(left.linkId || '').localeCompare(String(right.linkId || ''));
}

function sortByEventSignature(left, right) {
  const workspaceComparison = normalizeWorkspaceId(left.workspaceId).localeCompare(normalizeWorkspaceId(right.workspaceId));
  if (workspaceComparison !== 0) return workspaceComparison;

  const memoryComparison = String(left.memoryId || '').localeCompare(String(right.memoryId || ''));
  if (memoryComparison !== 0) return memoryComparison;

  const createdComparison = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  if (createdComparison !== 0) return createdComparison;

  const eventTypeOrder = {
    CREATED: 0,
    UPDATED: 1,
    LINKED: 2,
    TOMBSTONE: 3,
  };
  const leftType = eventTypeOrder[left.eventType] ?? 99;
  const rightType = eventTypeOrder[right.eventType] ?? 99;
  const eventTypeComparison = leftType - rightType;
  if (eventTypeComparison !== 0) return eventTypeComparison;

  return String(left.eventId || '').localeCompare(String(right.eventId || ''));
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Thrown to abort an importPackage transaction the moment a conflict is seen
 * in strict mode (#400), so the rollback path that already exists for
 * persistence errors also covers conflicts. It never escapes importPackage.
 */
class ImportConflictError extends Error {
  constructor() {
    super('import conflicts detected');
    this.name = 'ImportConflictError';
  }
}

function cloneMemoryRecord(record) {
  if (!record) return null;
  return {
    ...record,
    content: deepClone(record.content),
    metadata: deepClone(record.metadata) ?? {},
    provenance: deepClone(record.provenance),
  };
}

function cloneMemoryEvent(event) {
  if (!event) return null;
  return {
    ...event,
    details: deepClone(event.details) ?? {},
    provenance: deepClone(event.provenance),
  };
}

function cloneMemoryLink(link) {
  if (!link) return null;
  return {
    ...link,
    provenance: deepClone(link.provenance),
    metadata: deepClone(link.metadata) ?? {},
  };
}

function parseTemporalBoundary(value) {
  if (value === undefined || value === null || value === '') return '';
  return isValidIsoDate(value) ? String(value).trim() : '';
}

function readTemporalField(record, field) {
  if (!record || typeof record !== 'object') return '';
  if (field === 'updatedAt') return parseTemporalBoundary(record.updatedAt);
  if (field === 'deletedAt') return parseTemporalBoundary(record.deletedAt);
  if (field === 'accessedAt') return parseTemporalBoundary(record.updatedAt || record.createdAt);
  return parseTemporalBoundary(record.createdAt);
}

function matchesTemporalRange(value, range) {
  if (!value) return false;
  if (range.since && value < range.since) return false;
  if (range.after && value <= range.after) return false;
  if (range.before && value >= range.before) return false;
  if (range.until && value > range.until) return false;
  if (range.start && value < range.start) return false;
  if (range.end && value > range.end) return false;
  return true;
}

module.exports = {
  sortByCreatedAtThenId,
  sortByLinkSignature,
  sortByEventSignature,
  deepClone,
  ImportConflictError,
  cloneMemoryRecord,
  cloneMemoryEvent,
  cloneMemoryLink,
  parseTemporalBoundary,
  readTemporalField,
  matchesTemporalRange,
};
