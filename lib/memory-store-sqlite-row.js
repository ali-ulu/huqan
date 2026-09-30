'use strict';

// One memories row -> a validated record (#3208). Shared by the open-time
// integrity scan (memory-store-sqlite-warmup.js) and the SQLite-backed
// collection's lazy loads (memory-store-sqlite-collection.js).

const { normalizeMemoryRecord, validateMemoryEvent, validateMemoryLink, validateMemoryRecord } = require('./memory-schema');

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch (_) {
    const error = new Error(`${field} is not valid JSON`);
    error.code = 'INVALID_JSON';
    throw error;
  }
}

/**
 * Parse and validate one memories row.
 * @returns {{ record: object }|{ errors: object[] }}
 */
function parseMemoryRow(row) {
  try {
    const record = normalizeMemoryRecord({
      memoryId: row.memory_id,
      workspaceId: row.workspace_id,
      content: parseJson(row.content_json, 'content_json'),
      createdAt: row.created_at,
      updatedAt: row.updated_at || undefined,
      deletedAt: row.deleted_at || undefined,
      supersedesMemoryId: row.supersedes_memory_id || undefined,
      status: row.status,
      metadata: parseJson(row.metadata_json, 'metadata_json'),
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
    });
    const validation = validateMemoryRecord(record);
    if (!validation.ok) return { errors: validation.errors };
    Object.freeze(record.content);
    return { record };
  } catch (error) {
    return { errors: [{ code: error.code || 'PARSE_ERROR', message: error.message }] };
  }
}

/**
 * Parse and validate one memory_events row. Key order and the undefined
 * relatedMemoryId match the loader this replaced; the columns #3208 added
 * (review stamp, schemaVersion) appear only when the row carries them.
 * @returns {{ event: object }|{ errors: object[] }}
 */
function parseEventRow(row) {
  try {
    const event = {
      eventId: row.event_id,
      eventType: row.event_type,
      memoryId: row.memory_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      actor: row.actor,
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
      details: parseJson(row.details_json, 'details_json'),
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
      relatedMemoryId: row.related_memory_id || undefined,
      ...(row.schema_version ? { schemaVersion: row.schema_version } : {}),
    };
    const validation = validateMemoryEvent(event);
    if (!validation.ok) return { errors: validation.errors };
    return { event };
  } catch (error) {
    return { errors: [{ code: error.code || 'PARSE_ERROR', message: error.message }] };
  }
}

/**
 * Parse and validate one memory_links row. Key order matches the loader this
 * replaced; the columns #3208 added (metadata, schemaVersion) appear only when
 * the row carries them, so rows written before read back as they did.
 * @returns {{ link: object }|{ errors: object[] }}
 */
function parseLinkRow(row) {
  try {
    const link = {
      linkId: row.link_id,
      relation: row.relation,
      fromMemoryId: row.from_memory_id,
      toMemoryId: row.to_memory_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
      strength: row.confidence !== null ? row.confidence : undefined,
      ...(row.metadata_json ? { metadata: parseJson(row.metadata_json, 'metadata_json') } : {}),
      ...(row.schema_version ? { schemaVersion: row.schema_version } : {}),
    };
    const validation = validateMemoryLink(link);
    if (!validation.ok) return { errors: validation.errors };
    return { link };
  } catch (error) {
    return { errors: [{ code: error.code || 'PARSE_ERROR', message: error.message }] };
  }
}

module.exports = { parseJson, parseEventRow, parseLinkRow, parseMemoryRow };
