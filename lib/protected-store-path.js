'use strict';

// Where the protected per-workspace memory store lives (ADR-018 §2, #3998).
//
// ADR-017 decided the memory store moves out of the working directory into a
// protected state root. ADR-018 §2 fixes the layout:
//
//   root                       C:\ProgramData\huqan\state
//   per-workspace database     state\workspaces\<workspace-id>\memory.db
//   per-workspace JSON         state\workspaces\<workspace-id>\memory.json
//   migration marker           state\workspaces\<workspace-id>\migrated.json
//
// `workspace-id` is the first 16 hex characters of the sha256 of the lowercased
// canonical realpath of the workspace root. Hashing the realpath means two
// spellings of one directory (a short 8.3 name, a symlinked path, mixed case)
// resolve to the same database, and a workspace that moves keeps a new id
// rather than silently adopting the old store.
//
// A leaf on purpose: `lib/default-persistence-path.js` is a require-cycle leaf
// that may require nothing but node builtins, and it needs this module to
// answer "is a protected store selected?" on the default-path hot path. This
// module therefore requires nothing but node builtins too, so both sides of the
// graph/persistence cycle can depend on it downward.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_ROOT_OVERRIDE_VARIABLE = 'HUQAN_PROTECTED_STATE_ROOT';
const WORKSPACES_DIRNAME = 'workspaces';
const DB_FILENAME = 'memory.db';
const JSON_FILENAME = 'memory.json';
const MARKER_FILENAME = 'migrated.json';
const MARKER_VERSION = 'huqan.store-migration.v1';
const WORKSPACE_ID_LENGTH = 16;

/**
 * The protected state root. Windows is the ADR's named platform; the POSIX
 * default mirrors its shape (`/var/lib/huqan/state`) so the same code and the
 * same tests describe both. `HUQAN_PROTECTED_STATE_ROOT` names it outright,
 * which is how a test or a non-default install points the store elsewhere.
 */
function protectedStateRoot(environment = process.env, platform = process.platform) {
  const override = typeof environment[STATE_ROOT_OVERRIDE_VARIABLE] === 'string'
    ? environment[STATE_ROOT_OVERRIDE_VARIABLE].trim()
    : '';
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    const programData = typeof environment.ProgramData === 'string' && environment.ProgramData.trim()
      ? environment.ProgramData.trim()
      : 'C:\\ProgramData';
    return path.win32.join(programData, 'huqan', 'state');
  }
  return path.join('/var', 'lib', 'huqan', 'state');
}

/**
 * The canonical realpath of a directory, with the case folded. Falls back to
 * the resolved (not realpath'd) spelling when the directory does not exist yet,
 * so deriving an id never fails on a path that is merely absent.
 */
function canonicalWorkspaceRoot(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (_) {
    canonical = resolved;
  }
  return canonical.toLowerCase();
}

/** First 16 hex characters of sha256(lowercased canonical realpath). */
function deriveWorkspaceId(workspaceRoot) {
  return crypto.createHash('sha256').update(canonicalWorkspaceRoot(workspaceRoot)).digest('hex')
    .slice(0, WORKSPACE_ID_LENGTH);
}

function workspacesRoot(stateRoot = protectedStateRoot()) {
  return path.join(path.resolve(stateRoot), WORKSPACES_DIRNAME);
}

function workspaceStoreDir(workspaceRoot, stateRoot = protectedStateRoot()) {
  return path.join(workspacesRoot(stateRoot), deriveWorkspaceId(workspaceRoot));
}

function protectedMemoryDbPath(workspaceRoot, stateRoot = protectedStateRoot()) {
  return path.join(workspaceStoreDir(workspaceRoot, stateRoot), DB_FILENAME);
}

function protectedMemoryJsonPath(workspaceRoot, stateRoot = protectedStateRoot()) {
  return path.join(workspaceStoreDir(workspaceRoot, stateRoot), JSON_FILENAME);
}

function migrationMarkerPath(workspaceRoot, stateRoot = protectedStateRoot()) {
  return path.join(workspaceStoreDir(workspaceRoot, stateRoot), MARKER_FILENAME);
}

/**
 * Read and shape-check the migration marker. Absent, unreadable, malformed or
 * wrong-version all read as "not migrated": the marker is the evidence that a
 * verified copy exists, and anything short of a well-formed marker is not that
 * evidence. Never throws on the hot path -- the caller decides fail-closed.
 */
function readMigrationMarker(markerPath, readFile = file => fs.readFileSync(file, 'utf8')) {
  let text;
  try {
    text = readFile(markerPath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? { absent: true } : { reason: 'marker_unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return { reason: 'marker_malformed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.v !== MARKER_VERSION
    || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId.trim()
    || typeof parsed.dbSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.dbSha256)) {
    return { reason: 'marker_malformed' };
  }
  return { marker: parsed };
}

/**
 * Whether the protected store is selected for this workspace, and why not when
 * it is not. "Selected" means the migration marker is present and well-formed;
 * the marker is only written after a verified copy, so its presence is the
 * switch. The richer verification (the copy still matches the profile original,
 * the ACL still matches) is the boundary check's job (ADR-018 §1 (b) and (c)),
 * not this resolver's.
 */
function resolveProtectedStore({
  workspaceRoot = process.cwd(),
  stateRoot = protectedStateRoot(),
  readFile,
} = {}) {
  const workspaceId = deriveWorkspaceId(workspaceRoot);
  const markerPath = migrationMarkerPath(workspaceRoot, stateRoot);
  const read = readMigrationMarker(markerPath, readFile);
  if (read.absent) return { selected: false, reason: 'no_marker', workspaceId, stateRoot };
  if (!read.marker) return { selected: false, reason: read.reason, workspaceId, stateRoot };
  return {
    selected: true,
    workspaceId,
    stateRoot,
    marker: read.marker,
    markerPath,
    memoryPath: protectedMemoryJsonPath(workspaceRoot, stateRoot),
    dbPath: protectedMemoryDbPath(workspaceRoot, stateRoot),
  };
}

/**
 * The protected memory path for a workspace, or null when no protected store is
 * selected. This is the single hook the three default-path resolvers consult
 * (`lib/default-persistence-path.js`, `persistencePaths.js`,
 * `lib/agent-v3-storage-factory.js`) so that, once a store is selected, none of
 * them derives a path from the working directory (ADR-018 §2, last bullet).
 *
 * Returns the JSON path because that is the path the other two derive their
 * siblings from; the database sits beside it in the same directory.
 */
function protectedMemoryPathIfSelected({ workspaceRoot = process.cwd(), stateRoot = protectedStateRoot(), readFile } = {}) {
  const selection = resolveProtectedStore({ workspaceRoot, stateRoot, readFile });
  if (!selection.selected) return null;
  return { memoryPath: selection.memoryPath, dbPath: selection.dbPath, workspaceId: selection.workspaceId, stateRoot: selection.stateRoot };
}

module.exports = {
  DB_FILENAME,
  JSON_FILENAME,
  MARKER_FILENAME,
  MARKER_VERSION,
  STATE_ROOT_OVERRIDE_VARIABLE,
  WORKSPACES_DIRNAME,
  WORKSPACE_ID_LENGTH,
  canonicalWorkspaceRoot,
  deriveWorkspaceId,
  migrationMarkerPath,
  protectedMemoryDbPath,
  protectedMemoryJsonPath,
  protectedMemoryPathIfSelected,
  protectedStateRoot,
  readMigrationMarker,
  resolveProtectedStore,
  workspaceStoreDir,
  workspacesRoot,
};
