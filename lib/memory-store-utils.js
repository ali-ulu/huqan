const crypto = require('crypto');
const path = require('path');

function toStableString(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(toStableString).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + toStableString(val[k]));
  }
  return '{' + parts.join(',') + '}';
}

function isValidIsoDate(str) {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function makeProvenance(actor, workspaceId, trustPolicyVersion) {
  const now = new Date().toISOString();
  return {
    provenanceId: generateEventId(),
    sourceRef: 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: 'memory-api',
    actor: actor || 'system',
    timestamp: now,
    workspaceId: normalizeWorkspaceId(workspaceId),
    trustPolicyVersion: trustPolicyVersion || '1.0.0',
    confidence: 1.0,
  };
}

function generateEventId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function normalizeWorkspaceId(value) {
  return String(value || 'default').trim() || 'default';
}

function getContentHash(content) {
  const payload = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function resolveDbPath(opts = {}) {
  if (opts.dbPath) return opts.dbPath;
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.endsWith('.json')) {
    return opts.memoryPath.replace(/\.json$/, '.db');
  }
  return path.join(process.cwd(), 'memory.db');
}

function generateMemoryId(content, workspaceId, createdAt) {
  const payload = JSON.stringify({ content, workspaceId, createdAt });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function generateLinkId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function generateDeterministicLinkId(workspaceId, fromMemoryId, toMemoryId, relation) {
  const payload = JSON.stringify({ workspaceId, fromMemoryId, toMemoryId, relation });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

module.exports = {
  toStableString,
  isValidIsoDate,
  makeProvenance,
  getContentHash,
  resolveDbPath,
  generateMemoryId,
  generateLinkId,
  generateDeterministicLinkId,
  generateEventId,
  normalizeWorkspaceId,
};
