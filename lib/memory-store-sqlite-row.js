'use strict';

// One memories row -> a validated record (#3208). Shared by the open-time
// integrity scan (memory-store-sqlite-warmup.js) and the SQLite-backed
// collection's lazy loads (memory-store-sqlite-collection.js).

const { normalizeMemoryRecord, validateMemoryRecord } = require('./memory-schema');

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

module.exports = { parseJson, parseMemoryRow };
