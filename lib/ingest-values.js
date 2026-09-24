// #2171: ingest's snapshot contract constants and the string, path and hash
// helpers every ingest step shares.

const crypto = require('crypto');

const EXTERNAL_SOURCE_SNAPSHOT_VERSION = 'huqan.external-source-snapshot.v1';
const MAX_EXTERNAL_SNAPSHOT_FILES = 200;
const MAX_EXTERNAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_FILE_FIELDS = new Set(['path', 'content', 'contentHash', 'sizeBytes', 'blobSha']);
const SNAPSHOT_FIELDS = Object.freeze({
  github: new Set([
    'version',
    'sourceType',
    'sourceRef',
    'immutableSourceId',
    'repoUrl',
    'commitSha',
    'files',
    'manifestHash',
  ]),
  markdown: new Set([
    'version',
    'sourceType',
    'sourceRef',
    'immutableSourceId',
    'path',
    'rootPath',
    'files',
    'manifestHash',
  ]),
});

function sanitizeString(value, maxLen = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function strictString(value, maxLen) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLen) return '';
  return text;
}

function normalizeSourceType(sourceType) {
  const raw = sanitizeString(sourceType, 32).toLowerCase();
  if (raw === 'repo') return 'github';
  if (raw === 'manuel') return 'manual';
  if (raw === 'karar') return 'decision';
  return raw;
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex')}`;
}

function normalizeGitHubCommitSha(value) {
  const commitSha = strictString(value, 64).toLowerCase();
  return /^[0-9a-f]{40}$/.test(commitSha) ? commitSha : '';
}

function normalizeSnapshotPath(value) {
  const input = strictString(value, 1024);
  if (!input || /%[0-9a-f]{2}/i.test(input) || /[\u0000-\u001f\u007f]/u.test(input)) return ''; // oxlint-disable-line no-control-regex -- deliberate: rejects the control characters this ingest boundary refuses

  const normalized = input.normalize('NFC').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.length > 1024 || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return '';

  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[.\s]$/u.test(part))) return '';
  return parts.join('/');
}

function compareSnapshotPaths(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function snapshotFailure(code, error) {
  return { ok: false, code, error };
}

module.exports = {
  EXTERNAL_SOURCE_SNAPSHOT_VERSION,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  MAX_EXTERNAL_SNAPSHOT_FILES,
  SNAPSHOT_FIELDS,
  SNAPSHOT_FILE_FIELDS,
  compareSnapshotPaths,
  hashText,
  normalizeGitHubCommitSha,
  normalizeSnapshotPath,
  normalizeSourceType,
  sanitizeString,
  sha256,
  sha256Text,
  snapshotFailure,
  stableStringify,
  strictString,
};
