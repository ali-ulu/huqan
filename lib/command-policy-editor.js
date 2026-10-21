'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeExternalActionEnvelope } = require('./external-action-envelope');
const { getPolicyTemplate } = require('./command-policy-templates');

const MAX_BYTES = 64 * 1024;
function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function commands(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(item =>
    // oxlint-disable-next-line no-control-regex -- deliberate: rejects control characters in a policy command
    typeof item !== 'string' || !item.trim() || item.length > 500 || /[\x00-\x1f\x7f]/.test(item))) {
    fail('INVALID_COMMANDS');
  }
  return [...new Set(value.map(item => item.trim()))];
}

/**
 * The residency destinations an operator declared, as the policy file stores
 * them: host names, one entry per destination, nothing else.
 *
 * A string is accepted as one comma-separated list, so a caller that has the
 * value as text does not have to split it twice. An entry that is not a
 * string is dropped rather than guessed at.
 */
function residencyDestinations(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
  const destinations = list
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    // oxlint-disable-next-line no-control-regex -- deliberate: rejects control characters in a residency host
    .filter(entry => entry && entry.length <= 253 && !/[\x00-\x1f\x7f]/.test(entry));
  return [...new Set(destinations)];
}

// Only the deployment supplies target. HTTP callers cannot choose a file.
function createCommandPolicyEditor(target) {
  function read() {
    let raw = null;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('POLICY_UNREADABLE', 409);
      raw = fs.readFileSync(target, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let value;
    try { value = raw === null ? {} : JSON.parse(raw); } catch { fail('POLICY_UNREADABLE', 409); }
    if (!value || typeof value !== 'object') fail('POLICY_UNREADABLE', 409);
    const allowedCommands = commands(Array.isArray(value) ? value : (value.allowedCommands ?? []));
    return { value, allowedCommands, revision: crypto.createHash('sha256').update(raw === null ? 'missing' : `file:${raw}`).digest('hex') };
  }
  function snapshot() {
    const { allowedCommands, revision } = read();
    return { allowedCommands, revision, scope: 'shared-policy-file', hostVerified: false };
  }
  // The lock serializes editors across server processes; stale locks fail closed.
  function locked(work) {
    const lockPath = `${target}.editor-lock`;
    let lock;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') fail('POLICY_BUSY', 409);
      throw error;
    }
    try {
      return work();
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
  // The atomic write both paths use: a temporary file beside the target, an
  // mtime bump so the guard's cache invalidates even for an equal-size edit,
  // and a rename. The temporary file never survives a failure.
  function writeDocument(value) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('POLICY_TOO_LARGE', 413);
    const temporary = path.join(path.dirname(target), `.huqan-policy-${crypto.randomUUID()}.tmp`);
    let written = false;
    try {
      const previous = fs.existsSync(target) ? fs.statSync(target) : null;
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o600 });
      written = true;
      const modified = new Date(Math.max(Date.now(), (previous?.mtimeMs || 0) + 1000));
      fs.utimesSync(temporary, modified, modified);
      fs.renameSync(temporary, target);
      written = false;
    } finally {
      if (written) fs.unlinkSync(temporary);
    }
  }
  function save(input) {
    const allowedCommands = commands(input.allowedCommands);
    if (typeof input.revision !== 'string') fail('REVISION_REQUIRED');
    return locked(() => {
      const current = read();
      if (input.revision !== current.revision) fail('POLICY_CHANGED', 409);
      const value = Array.isArray(current.value) ? {} : current.value;
      writeDocument({ ...value, allowedCommands });
      return snapshot();
    });
  }
  /**
   * Replace the deployment's policy file with a built-in template (#4102).
   *
   * An existing file is never replaced without the operator's explicit
   * approval, and an approved replacement backs the old file up first: the
   * deployment's own edits are not something a template may throw away. The
   * template only supplies the allowed commands; the file, its path and the
   * decision to replace it stay with the deployment.
   */
  function applyTemplate(id, options = {}) {
    const template = getPolicyTemplate(id);
    if (!template) fail('UNKNOWN_TEMPLATE', 404);
    const allowedCommands = commands([...template.allowedCommands]);
    const allowedDestinations = residencyDestinations(options.residency);
    const value = {
      allowedCommands,
      ...(allowedDestinations.length ? { dataResidency: { allowedDestinations } } : {}),
    };
    // The scope directory of a workspace policy file may not exist yet: the
    // gate reads a missing file as an empty list, and an apply needs
    // somewhere to write. The lock file lives beside the target, so the
    // directory has to exist before the lock is taken.
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    return locked(() => {
      // Checked under the lock, so a file that appeared in the meantime is
      // still an existing file this call must not replace.
      const replaced = fs.existsSync(target);
      if (replaced && options.approved !== true) fail('POLICY_EXISTS', 409);
      let backup = null;
      if (replaced) {
        // The copy keeps the old file's mode, and the exclusive flag refuses
        // to overwrite a backup that is already there.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = `${target}.backup-${stamp}`;
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
      }
      writeDocument(value);
      return {
        ...snapshot(),
        template: template.id,
        target,
        backup,
        residency: allowedDestinations,
        requiresResidency: template.requiresResidency === true,
      };
    });
  }
  function preview(input) {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 2000) fail('INVALID_COMMAND');
    const current = snapshot();
    if (input.revision !== current.revision) fail('POLICY_CHANGED', 409);
    const envelope = normalizeExternalActionEnvelope({
      agentName: 'policy-preview', sessionId: 'preview', toolName: 'shell', kind: 'shell',
      args: { command: input.command }, cwd: path.dirname(target), workspaceRoot: path.dirname(target),
    }, { allowedCommands: current.allowedCommands });
    return { revision: current.revision, category: envelope.riskCategory,
      matchedCommand: envelope.allowlistedCommand, executed: false, hostVerified: false };
  }
  return Object.freeze({ snapshot, save, applyTemplate, preview });
}

module.exports = { createCommandPolicyEditor };
