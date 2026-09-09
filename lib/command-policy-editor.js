'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeExternalActionEnvelope } = require('./external-action-envelope');

const MAX_BYTES = 64 * 1024;
function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function commands(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 500 || /[\x00-\x1f\x7f]/.test(item))) {
    fail('INVALID_COMMANDS');
  }
  return [...new Set(value.map(item => item.trim()))];
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
  function save(input) {
    const allowedCommands = commands(input.allowedCommands);
    if (typeof input.revision !== 'string') fail('REVISION_REQUIRED');
    // The lock serializes editors across server processes; stale locks fail closed.
    const lockPath = `${target}.editor-lock`;
    let lock;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') fail('POLICY_BUSY', 409);
      throw error;
    }
    let temporary;
    try {
      const current = read();
      if (input.revision !== current.revision) fail('POLICY_CHANGED', 409);
      const value = Array.isArray(current.value) ? {} : current.value;
      const bytes = `${JSON.stringify({ ...value, allowedCommands }, null, 2)}\n`;
      if (Buffer.byteLength(bytes) > MAX_BYTES) fail('POLICY_TOO_LARGE', 413);
      temporary = path.join(path.dirname(target), `.huqan-policy-${crypto.randomUUID()}.tmp`);
      const previous = fs.existsSync(target) ? fs.statSync(target) : null;
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: previous ? previous.mode & 0o777 : 0o600 });
      // Ensure even equal-size edits invalidate the hook's mtime/size cache.
      const modified = new Date(Math.max(Date.now(), (previous?.mtimeMs || 0) + 1000));
      fs.utimesSync(temporary, modified, modified);
      fs.renameSync(temporary, target);
      temporary = null;
      return snapshot();
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
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
  return Object.freeze({ snapshot, save, preview });
}

module.exports = { createCommandPolicyEditor };
