'use strict';

/**
 * Plugin/skill provenance registry (#1890).
 *
 * The loader verified *file identity* (hash/signature against the adjacent
 * manifest) but recorded none of it: a silently upgraded plugin kept its old
 * trust assumptions, plugin-to-plugin dependencies were undeclared, and
 * capability grants were checked once at load/install and never again.
 *
 * This registry is the missing record. It is deliberately pure (no fs, no
 * console) so the policy stays testable; PluginManager supplies the live
 * state and decides what to do with a failed re-validation.
 *
 * Per load it records: signature status, publisher provenance (issuer),
 * version, content hash, granted capabilities, and declared dependencies.
 * It maintains the plugin-to-plugin dependency graph (verified at load),
 * re-evaluates a grant against live state at runtime (per invocation or
 * periodic), and appends a changelog entry whenever a plugin's capabilities
 * change across versions.
 */

const UNKNOWN_VERSION = 'unversioned';
const UNKNOWN_ISSUER = 'unattested';

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function uniqueStrings(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const names = [];
  for (const item of list) {
    const name = typeof item === 'string' ? item.trim() : text(item && item.name);
    if (name) names.push(name);
  }
  return [...new Set(names)].sort();
}

/**
 * A dependency spec is `name` or `name@version`. The version pin is exact:
 * `reporter@1.2.0` is satisfied only by version `1.2.0`. An absent pin accepts
 * any recorded version.
 */
function parseDependency(spec) {
  const raw = text(spec);
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { name: raw, version: null, spec: raw };
  const name = raw.slice(0, at).trim();
  const version = raw.slice(at + 1).trim();
  if (!name) return null;
  return { name, version: version || null, spec: raw };
}

function readNow(options) {
  if (options && typeof options.now === 'function') {
    const value = options.now();
    if (typeof value === 'string' && value) return value;
  }
  return new Date().toISOString();
}

function createProvenanceRegistry(options = {}) {
  return {
    records: new Map(),
    changelog: [],
    changelogSeq: 0,
    now: typeof options.now === 'function' ? options.now : undefined,
  };
}

function capabilityDiff(before, after) {
  const prev = new Set(before);
  const next = new Set(after);
  return {
    added: [...next].filter(item => !prev.has(item)).sort(),
    removed: [...prev].filter(item => !next.has(item)).sort(),
  };
}

function appendChangelog(registry, entry, options = {}) {
  registry.changelogSeq += 1;
  const record = Object.freeze({
    seq: registry.changelogSeq,
    at: readNow(options.now ? { now: options.now } : { now: registry.now }),
    plugin: entry.plugin,
    fromVersion: entry.fromVersion,
    toVersion: entry.toVersion,
    addedCapabilities: Object.freeze([...entry.addedCapabilities]),
    removedCapabilities: Object.freeze([...entry.removedCapabilities]),
    reason: entry.reason,
  });
  registry.changelog.push(record);
  return record;
}

/**
 * Record one plugin load. Returns `{ record, changed, changelogEntry }`.
 *
 * `entry` fields: name (required), version, issuer, workspaceId,
 * signatureStatus, contentHash, capabilities, dependencies, filePath.
 * Absent version/issuer are recorded explicitly as `unversioned` /
 * `unattested` -- the record must say what it does not know, not silently
 * inherit the previous load's trust.
 */
function recordPluginLoad(registry, entry, options = {}) {
  const name = text(entry && entry.name);
  if (!name) {
    const error = new Error('Provenance record requires a plugin name.');
    error.code = 'PLUGIN_PROVENANCE_NAME_MISSING';
    throw error;
  }
  const version = text(entry.version) || UNKNOWN_VERSION;
  const issuer = text(entry.issuer) || UNKNOWN_ISSUER;
  const capabilities = uniqueStrings(entry.capabilities);
  const dependencies = uniqueStrings(entry.dependencies)
    .map(parseDependency)
    .filter(Boolean)
    .map(dep => dep.spec);
  const previous = registry.records.get(name) || null;

  const record = Object.freeze({
    name,
    version,
    issuer,
    workspaceId: text(entry.workspaceId) || '',
    signatureStatus: text(entry.signatureStatus) || 'unverified',
    contentHash: text(entry.contentHash) || '',
    capabilities: Object.freeze(capabilities),
    dependencies: Object.freeze(dependencies),
    filePath: text(entry.filePath) || '',
    firstSeenAt: previous ? previous.firstSeenAt : readNow({ now: registry.now }),
    lastSeenAt: readNow({ now: registry.now }),
    loadCount: (previous ? previous.loadCount : 0) + 1,
    depStatus: previous ? previous.depStatus : 'pending',
    revoked: previous ? previous.revoked : false,
  });
  registry.records.set(name, record);

  let changelogEntry = null;
  if (previous && (previous.version !== version || JSON.stringify([...previous.capabilities]) !== JSON.stringify(capabilities))) {
    const diff = capabilityDiff([...previous.capabilities], capabilities);
    changelogEntry = appendChangelog(registry, {
      plugin: name,
      fromVersion: previous.version,
      toVersion: version,
      addedCapabilities: diff.added,
      removedCapabilities: diff.removed,
      reason: 'plugin_reloaded_with_changed_grant',
    }, { now: registry.now });
  }
  void options;
  return { record, changed: Boolean(changelogEntry), changelogEntry };
}

function markDepStatus(registry, name, depStatus) {
  const current = registry.records.get(name);
  if (!current) return null;
  const updated = Object.freeze({ ...current, depStatus });
  registry.records.set(name, updated);
  return updated;
}

function markRevoked(registry, name) {
  const current = registry.records.get(name);
  if (!current) return null;
  const updated = Object.freeze({ ...current, revoked: true });
  registry.records.set(name, updated);
  return updated;
}

/**
 * Verify the whole dependency graph: every declared edge must resolve to a
 * recorded plugin (honoring an exact `@version` pin), and no dependency
 * cycle may exist. Returns `{ ok, unsatisfied, cycles }` -- the caller
 * decides whether an offender is evicted or only reported.
 */
function verifyDependencyGraph(registry) {
  const unsatisfied = [];
  const edges = new Map();
  for (const [name, record] of registry.records) {
    if (record.revoked) continue;
    const deps = [];
    for (const spec of record.dependencies) {
      const dep = parseDependency(spec);
      if (!dep) continue;
      deps.push(dep);
      const target = registry.records.get(dep.name);
      if (!target || target.revoked || (dep.version && target.version !== dep.version)) {
        unsatisfied.push({
          plugin: name,
          dependency: dep.spec,
          reason: !target ? 'dependency_not_loaded'
            : target.revoked ? 'dependency_revoked'
              : 'dependency_version_mismatch',
          ...(dep.version ? { expectedVersion: dep.version, actualVersion: target.version } : {}),
        });
      }
    }
    edges.set(name, deps.map(dep => dep.name).filter(target => registry.records.has(target)));
  }

  const cycles = [];
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const next of edges.get(node) || []) visit(next);
    stack.pop();
  }
  for (const name of edges.keys()) visit(name);

  return { ok: unsatisfied.length === 0 && cycles.length === 0, unsatisfied, cycles };
}

function dependencyGraph(registry) {
  const nodes = [];
  for (const record of registry.records.values()) {
    nodes.push(Object.freeze({
      plugin: record.name,
      version: record.version,
      dependencies: [...record.dependencies],
      depStatus: record.depStatus,
      revoked: record.revoked,
    }));
  }
  return Object.freeze(nodes);
}

/**
 * Re-evaluate one recorded grant against live state. Fail-closed: any drift
 * between what was recorded at load and what is live now -- file hash,
 * capability set, required kernel capabilities, dependency edges -- returns
 * `{ ok: false, reason }`. A capability change also appends a changelog entry
 * so a newly granted capability always surfaces with an audit trail.
 *
 * `current`: `{ version, issuer, signatureStatus, contentHash, capabilities,
 * dependencies }` read live from the plugin/manifest just now.
 * `context`: `{ hasCapability(name), loadedPlugins: [...] }` for the
 * kernel-capability and plugin-dependency checks.
 */
function revalidatePlugin(registry, name, current = {}, context = {}) {
  const recorded = registry.records.get(name);
  if (!recorded) return { ok: false, reason: 'provenance_not_recorded' };
  if (recorded.revoked) return { ok: false, reason: 'plugin_revoked' };

  const liveCapabilities = uniqueStrings(current.capabilities);
  if (recorded.contentHash && text(current.contentHash) && recorded.contentHash !== text(current.contentHash)) {
    return { ok: false, reason: 'content_hash_drift' };
  }
  if (JSON.stringify([...recorded.capabilities]) !== JSON.stringify(liveCapabilities)) {
    const diff = capabilityDiff([...recorded.capabilities], liveCapabilities);
    appendChangelog(registry, {
      plugin: name,
      fromVersion: recorded.version,
      toVersion: text(current.version) || recorded.version,
      addedCapabilities: diff.added,
      removedCapabilities: diff.removed,
      reason: 'runtime_capability_drift',
    }, { now: registry.now });
    return { ok: false, reason: 'capability_drift' };
  }

  if (typeof context.hasCapability === 'function') {
    const required = uniqueStrings(context.requiredCapabilities);
    for (const capability of required) {
      if (!context.hasCapability(capability)) {
        return { ok: false, reason: 'required_capability_disabled', capability };
      }
    }
  }

  if (Array.isArray(context.loadedPlugins)) {
    const loaded = new Set(context.loadedPlugins);
    for (const spec of recorded.dependencies) {
      const dep = parseDependency(spec);
      if (!dep) continue;
      const target = registry.records.get(dep.name);
      if (!loaded.has(dep.name) || !target || target.revoked
        || (dep.version && target.version !== dep.version)) {
        return { ok: false, reason: 'dependency_unsatisfied_at_runtime', dependency: dep.spec };
      }
    }
  }

  return { ok: true, reason: 'grant_unchanged' };
}

function revalidateAll(registry, resolveCurrent, context = {}) {
  const results = [];
  for (const name of registry.records.keys()) {
    const current = typeof resolveCurrent === 'function' ? resolveCurrent(name) || {} : {};
    results.push({ plugin: name, ...revalidatePlugin(registry, name, current, context) });
  }
  return results;
}

function getRecord(registry, name) {
  return registry.records.get(text(name)) || null;
}

function listRecords(registry) {
  return [...registry.records.values()];
}

function listChangelog(registry) {
  return [...registry.changelog];
}

module.exports = {
  UNKNOWN_VERSION,
  UNKNOWN_ISSUER,
  createProvenanceRegistry,
  recordPluginLoad,
  markDepStatus,
  markRevoked,
  parseDependency,
  verifyDependencyGraph,
  dependencyGraph,
  revalidatePlugin,
  revalidateAll,
  getRecord,
  listRecords,
  listChangelog,
};
