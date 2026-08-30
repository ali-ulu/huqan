'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configuredIngestRoots } = require('./connectors/entry-ingest-flow');

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validPath(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}

// Preserve empty-ingest behavior for missing targets, but resolve every existing
// ancestor. lstat distinguishes missing entries from dangling symbolic links:
// an existing link whose realpath fails must not be treated as a missing file.
function realTarget(candidate) {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(realTarget(parent), path.basename(candidate));
  }
  return fs.realpathSync(candidate);
}

function validateConnectorLocalPath(targetPath, rootPath) {
  if (!targetPath) return { ok: false, reason: 'CONNECTOR_TARGET_REQUIRED' };
  if (!rootPath) return { ok: false, reason: 'CONNECTOR_ROOT_REQUIRED' };
  if (!validPath(targetPath) || !validPath(rootPath)) {
    return { ok: false, reason: 'CONNECTOR_TARGET_INVALID' };
  }
  try {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(targetPath);
    const canonicalRoot = fs.realpathSync(root);
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      return { ok: false, reason: 'CONNECTOR_ROOT_INVALID' };
    }
    // Share deployment policy, not the upstream resolver or its containment
    // implementation. Caller-provided roots can only narrow this boundary.
    const authorized = configuredIngestRoots().some(allowed => {
      if (!within(allowed, root)) return false;
      try { return within(fs.realpathSync(allowed), canonicalRoot); }
      catch (_) { return false; }
    });
    if (!authorized) return { ok: false, reason: 'CONNECTOR_ROOT_NOT_ALLOWED' };
    if (!within(root, candidate)) return { ok: false, reason: 'CONNECTOR_PATH_OUTSIDE_ROOT' };
    const target = realTarget(candidate);
    if (!within(canonicalRoot, target)) return { ok: false, reason: 'CONNECTOR_PATH_OUTSIDE_ROOT' };
    // This admission check is not a filesystem snapshot. Adapters must retain
    // their per-entry traversal checks; mutable-filesystem TOCTOU is not solved.
    return { ok: true, target, rootPath: canonicalRoot };
  } catch (_) {
    return { ok: false, reason: 'CONNECTOR_PATH_RESOLUTION_FAILED' };
  }
}

module.exports = { validateConnectorLocalPath };
