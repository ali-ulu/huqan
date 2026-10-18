'use strict';

// The CLI `store` command (ADR-018 §2, #3998): `huqan store migrate` and
// `huqan store migrate --rollback`.
//
// A thin wrapper: the decision and the copy/verify/marker order live in
// lib/authority/store-migrate.js. What this module owns is the operator-facing
// shape -- where the profile store is, whether the shell is elevated, and the
// sentence that tells the operator what happened. Elevation is passed through
// so a test can decide it; the CLI passes the real probe.
//
// `store` is a Platform entrypoint: it composes the authority modules and the
// profile paths, and holds no domain logic of its own. The profile-path
// resolver is injected rather than required: `persistencePaths.js` is Adapters
// while this module is Core, so the cli.js entrypoint hands the resolver in
// (the same shape as the coder loop and the hypothesis cognition).
//
// `./protected-store-path` is Core and this module is Core, so the layout
// helpers are required directly.

const path = require('node:path');

const { migrateStore, rollbackStore, isProcessElevated } = require('./authority/store-migrate');
const { protectedStateRoot, workspaceStoreDir, deriveWorkspaceId } = require('./protected-store-path');

const MIGRATE_USAGE = 'Usage: huqan store migrate [--rollback] [--workspace <dir>]';

/**
 * The profile store directory: where the workspace's memory lives today, before
 * any migration. Resolved through the injected resolver, so the command copies
 * the store the runtime is actually using.
 */
function profileStoreDir(workspaceRoot, resolvePaths) {
  if (typeof resolvePaths !== 'function') {
    throw new TypeError('profileStoreDir requires the persistence-path resolver');
  }
  const { memoryPath } = resolvePaths({ rootDir: workspaceRoot });
  return path.dirname(path.resolve(memoryPath));
}

function formatOutcome(result, workspaceRoot, stateRoot) {
  if (result.ok && result.alreadyRolledBack) {
    return `Rollback complete: no migration marker at ${result.markerPath}; resolution already follows the profile store.`;
  }
  if (result.ok && result.marker) {
    const json = result.marker.memoryJson?.present ? 'memory.json' : 'memory.json absent';
    return [
      `Migration complete: workspace ${result.marker.workspaceId} (${workspaceRoot}).`,
      `Protected store: ${result.dbPath} (${json}).`,
      `The profile store was left in place as the backup: ${result.marker.sourceDir}.`,
      'Run "huqan store migrate --rollback" to follow the profile store again.',
    ].join('\n');
  }
  if (result.ok) {
    return `Rollback complete: the migration marker at ${result.markerPath} was removed. The protected copy is kept at ${result.protectedCopyKept}.`;
  }
  return `Migration refused: ${result.reason}${result.detail ? ` -- ${result.detail}` : ''}. The profile store is unchanged.`;
}

/**
 * @param {object} args
 * @param {boolean} [args.rollback]
 * @param {string}  [args.workspace]  workspace root; defaults to cwd
 */
function runStoreCommand(args = {}, opts = {}, deps = {}) {
  const {
    isElevated = isProcessElevated(),
    stateRoot = protectedStateRoot(),
    resolvePaths,
    migrate = migrateStore,
    rollback = rollbackStore,
  } = deps;
  const workspaceRoot = path.resolve(args.workspace || process.cwd());

  if (args.help) return MIGRATE_USAGE;

  const result = args.rollback
    ? rollback({ workspaceRoot, stateRoot, isElevated })
    : migrate({
      workspaceRoot,
      sourceDir: profileStoreDir(workspaceRoot, resolvePaths),
      stateRoot,
      isElevated,
    });

  const text = formatOutcome(result, workspaceRoot, stateRoot);
  if (opts.json) {
    return {
      ok: result.ok === true,
      reason: result.reason || null,
      workspaceId: deriveWorkspaceId(workspaceRoot),
      workspaceRoot,
      stateRoot,
      protectedDir: workspaceStoreDir(workspaceRoot, stateRoot),
      marker: result.marker || null,
      message: text,
    };
  }
  return text;
}

module.exports = { MIGRATE_USAGE, formatOutcome, profileStoreDir, runStoreCommand };
