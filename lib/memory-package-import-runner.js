'use strict';

/**
 * Delegated from MemoryStore#importPackage by #328 MS.
 *
 * This module owns package validation, workspace/mode normalization, memory
 * admission decisions, conflict collection, and import orchestration. The
 * MemoryStore store API retains transaction/rollback ownership, SQLite
 * statements, the in-memory collections, and the existing event/link import
 * sinks. Persistence is invoked before each in-memory memory mutation.
 */
const {
  validateMemoryPackage,
  validateMemoryRecord,
  normalizeMemoryRecord,
} = require('./memory-schema');
const { getContentHash, normalizeWorkspaceId } = require('./memory-store-utils');
const { ImportConflictError } = require('./memory-record-utils');

/**
 * Store API required by runImportPackage.
 *
 * @typedef {object} ImportPackageStoreApi
 * @property {Function} findMemory - (memoryId, workspaceId) => record | undefined
 * @property {Function} snapshot - () => object
 * @property {Function} restore - snapshot => undefined
 * @property {Function} withTransaction - callback => result
 * @property {Function} persistMemory - (record, contentHash) => undefined
 * @property {Function} rememberMemory - record => undefined
 * @property {Function} importEvents - (events, context) => undefined
 * @property {Function} importLinks - (links, context) => undefined
 * @property {Function} persistenceError - error => {ok:false,error:object}
 */

function runImportPackage(storeApi, pkg, opts = {}) {
  const validation = validateMemoryPackage(pkg);
  if (!validation.ok) {
    return { ok: false, error: { code: 'INVALID_PACKAGE', message: 'package failed validation', details: validation.errors } };
  }

  const sourceOpts = opts && typeof opts === 'object' ? opts : {};
  const requestedWorkspaceId = sourceOpts.targetWorkspaceId !== undefined
    ? sourceOpts.targetWorkspaceId
    : sourceOpts.workspaceId;
  if (requestedWorkspaceId === undefined) {
    return {
      ok: false,
      error: { code: 'TARGET_WORKSPACE_REQUIRED', message: 'importPackage requires targetWorkspaceId or workspaceId' },
    };
  }

  let targetWorkspaceId;
  try {
    targetWorkspaceId = normalizeWorkspaceId(requestedWorkspaceId, { required: true });
  } catch (err) {
    return {
      ok: false,
      error: { code: err.code || 'WORKSPACE_ID_INVALID', message: 'target workspace must be a non-empty string' },
    };
  }

  const mode = sourceOpts.mode || 'idempotent';

  if (!Array.isArray(pkg.memories) || !Array.isArray(pkg.events) || !Array.isArray(pkg.links)) {
    return { ok: false, error: { code: 'INVALID_PACKAGE', message: 'package must contain memories, events, and links arrays' } };
  }

  const imported = { memories: 0, events: 0, links: 0 };
  const skipped = { memories: 0, events: 0, links: 0 };
  const conflicts = [];
  const packageWorkspaceId = normalizeWorkspaceId(pkg.workspaceId);
  if (packageWorkspaceId !== targetWorkspaceId) {
    const workspaceConflict = {
      type: 'workspace',
      reason: 'package workspace differs from target',
      packageWorkspaceId,
      targetWorkspaceId,
    };
    conflicts.push(workspaceConflict);
    if (mode === 'strict') {
      return { ok: false, error: { code: 'CONFLICT', message: 'import conflicts detected', details: conflicts } };
    }
  }

  const snapshot = storeApi.snapshot();
  try {
    storeApi.withTransaction(() => {
      for (const mem of pkg.memories) {
        const memWs = targetWorkspaceId;
        const existing = storeApi.findMemory(mem.memoryId, memWs);
        const contentHash = getContentHash(mem.content);

        if (existing) {
          const existingHash = getContentHash(existing.content);
          if (existingHash === contentHash && existing.workspaceId === memWs) {
            skipped.memories++;
            continue;
          }
          // A conflict is a conflict in every mode (#400). This used to be
          // recorded only under 'idempotent', which left `conflicts` empty in
          // strict mode -- making the strict check after the transaction
          // unreachable, and silently *overwriting* the existing record by
          // falling through to the insert below.
          conflicts.push({ type: 'memory', memoryId: mem.memoryId, reason: 'different content for same id' });
          if (mode === 'strict') throw new ImportConflictError();
          continue;
        }

        const normalized = normalizeMemoryRecord({
          memoryId: mem.memoryId,
          workspaceId: memWs,
          content: mem.content,
          createdAt: mem.createdAt,
          updatedAt: mem.updatedAt || undefined,
          deletedAt: mem.deletedAt || undefined,
          supersedesMemoryId: mem.supersedesMemoryId || undefined,
          status: mem.status || 'active',
          metadata: mem.metadata || {},
          provenance: mem.provenance,
          trustPolicyVersion: mem.trustPolicyVersion,
        });

        const memValidation = validateMemoryRecord(normalized);
        if (!memValidation.ok) {
          conflicts.push({ type: 'memory', memoryId: mem.memoryId, reason: memValidation.errors });
          continue;
        }

        storeApi.persistMemory(normalized, contentHash);
        storeApi.rememberMemory(normalized);
        imported.memories++;
      }

      // Events and links are admitted against the state this transaction
      // will leave behind, so a record can never cite a memory that was
      // skipped, rejected, or simply absent from the package (#761).
      const ctx = {
        workspaceId: targetWorkspaceId,
        imported,
        skipped,
        memoryExists: (memoryId) => Boolean(storeApi.findMemory(memoryId, targetWorkspaceId)),
        reject: (conflict) => {
          conflicts.push(conflict);
          if (mode === 'strict') throw new ImportConflictError();
        },
      };
      storeApi.importEvents(pkg.events, ctx);
      storeApi.importLinks(pkg.links, ctx);
    });
  } catch (err) {
    // Both paths roll back; only the cause differs.
    storeApi.restore(snapshot);
    if (err instanceof ImportConflictError) {
      return { ok: false, error: { code: 'CONFLICT', message: 'import conflicts detected', details: conflicts } };
    }
    return storeApi.persistenceError(err);
  }

  // No post-commit strict check any more (#400). A strict-mode conflict now
  // aborts inside the transaction and returns from the catch above, so
  // "import failed" can no longer be reported over a database that already
  // holds the non-conflicting records from the same package.
  // `skipped` was counted throughout the run but never returned, so a caller
  // saw `imported: {memories: 0, events: 0, links: 0}` for a re-import and
  // could not tell "everything was already here" from "nothing happened".
  return {
    ok: true,
    targetWorkspaceId,
    imported,
    skipped,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  };
}

module.exports = { runImportPackage };
