'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { produceProject } = require('./project-producer');
const { verifyDerivation, directoryReader } = require('./verify-derivation');

const permissions = new WeakMap();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function git(sourceRoot, args) {
  return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function sourceState(sourceRoot) {
  const real = fs.realpathSync.native(sourceRoot);
  if (fs.realpathSync.native(git(real, ['rev-parse', '--show-toplevel'])) !== real) throw new Error('PROJECT_SOURCE_UNKNOWN');
  const branch = git(real, ['branch', '--show-current']);
  if (!branch || branch === 'main' || branch === 'master') throw new Error('PROJECT_SOURCE_BRANCH_REFUSED');
  if (git(real, ['status', '--porcelain'])) throw new Error('PROJECT_SOURCE_DIRTY');
  return { root: real, branch, head: git(real, ['rev-parse', 'HEAD']) };
}

function emptyTarget(root, sourceRoot) {
  const absolute = path.resolve(root);
  // Every existing path component must be a real directory, not a link/junction.
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('PROJECT_TARGET_LINK_OR_INVALID');
    if (current === path.dirname(current)) break;
  }
  const real = fs.realpathSync.native(absolute);
  if (within(sourceRoot, real) || within(real, sourceRoot)) throw new Error('PROJECT_TARGET_OVERLAPS_SOURCE');
  if (fs.readdirSync(real).length) throw new Error('PROJECT_TARGET_NOT_EMPTY');
  return real;
}

// Issued only by an explicit operator entry, never from task metadata.
function createProjectInitializationPermission(spec, options = {}) {
  if (options.initialize !== true) return { ok: false, reason: 'PROJECT_INITIALIZATION_NOT_APPROVED' };
  const produced = produceProject(spec);
  if (!produced.ok) return produced;
  try {
    const source = sourceState(options.sourceRoot);
    const root = emptyTarget(options.root, source.root);
    const bytes = produced.task.operation.steps.reduce((sum, step) => sum + Buffer.byteLength(step.content), 0);
    if (bytes > 65536) return { ok: false, reason: 'PROJECT_OUTPUT_OVER_CAP' };
    const token = Object.freeze({});
    permissions.set(token, { root, source, taskHash: digest(produced.task), task: produced.task, claimed: false });
    return { ok: true, permission: token, ...produced, repoState: { known: true,
      branch: source.branch, dirty: false, hasUntracked: false } };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function evaluateProjectInitialization({ permission, root, task, patch, gate, policy, fileSystem }) {
  const entry = permissions.get(permission);
  if (!entry) return gate;
  try {
    if (entry.claimed || fileSystem !== fs || policy || digest(task) !== entry.taskHash || root !== entry.root) return gate;
    if (JSON.stringify(sourceState(entry.source.root)) !== JSON.stringify(entry.source)) return gate;
    emptyTarget(root, entry.source.root);
    if (gate.decision === 'block' || /^POLICY_/u.test(gate.reason)
      || gate.warnings.some(warning => warning !== 'Cross-cutting change across multiple surfaces detected.')
      || gate.fileFindings.some(finding => !['package', 'runtime', 'source', 'tests', 'docs'].includes(finding.category))) return gate;
    const steps = entry.task.operation.steps;
    if (patch.length !== 5 || patch.some(change => change.before !== null
      || !steps.some(step => step.path === change.path && step.content === change.after))) return gate;
    // A token cannot authorize a second application, even after rollback.
    entry.claimed = true;
    return { ...gate, decision: 'allow', allowed: true, canApply: true,
      reason: 'PROJECT_INITIALIZATION_APPROVED', requiredReview: false, dryRunOnly: false,
      operatorAuthorized: true, metadata: { ...gate.metadata, projectInitialization: {
        recipe: 'node_json_api', version: '1', taskHash: entry.taskHash, sourceHead: entry.source.head } } };
  } catch { return gate; }
}

function verifyProjectInitialization({ record, root }) {
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    return { ok: false, reason: 'PROJECT_TARGET_LINK_OR_INVALID' };
  }
  const expected = new Set(record.allowedPaths);
  function inspect(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix + name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!['src', 'test'].includes(relative) || !inspect(target, relative + '/')) return false;
      } else if (!stat.isFile() || !expected.delete(relative)) return false;
    }
    return true;
  }
  try {
    if (!inspect(root) || expected.size) return { ok: false, reason: 'PROJECT_OUTPUT_UNEXPECTED' };
  } catch { return { ok: false, reason: 'PROJECT_OUTPUT_READ_FAILED' }; }
  return verifyDerivation({ record, readBase: () => null, readHead: directoryReader(root) });
}

function activeProjectInitialization(permission) {
  return permissions.get(permission)?.claimed === true;
}

function cleanInitializationDirectories(permission, root) {
  if (!activeProjectInitialization(permission)) return true;
  try {
    if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root) return false;
    for (const name of ['src', 'test']) {
      const directory = path.join(root, name);
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    }
    return fs.readdirSync(root).length === 0;
  } catch { return false; }
}

module.exports = { createProjectInitializationPermission, evaluateProjectInitialization, verifyProjectInitialization,
  activeProjectInitialization, cleanInitializationDirectories };
