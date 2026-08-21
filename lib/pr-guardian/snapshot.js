'use strict';

const crypto = require('node:crypto');
const { buildGitHubProvenance } = require('../github-connector');

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(file => ({
    filename: text(file?.filename),
    status: text(file?.status).toLowerCase(),
    additions: Number(file?.additions || 0),
    deletions: Number(file?.deletions || 0),
    patch: text(file?.patch),
  })).filter(file => file.filename);
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map(check => ({
    name: text(check?.name),
    status: text(check?.status).toLowerCase(),
    conclusion: text(check?.conclusion).toLowerCase(),
    required: check?.required === true,
  })).filter(check => check.name);
}

function buildTargetHash(snapshot) {
  return sha256(stableJson({
    repo: snapshot.repo,
    number: snapshot.number,
    headSha: snapshot.headSha,
    baseRef: snapshot.baseRef,
    files: snapshot.files,
    checks: snapshot.checks,
  }));
}

function normalizePullRequestSnapshot(input = {}, options = {}) {
  const repo = text(input.repo || options.repo);
  const number = Number(input.number ?? options.number);
  const headSha = text(input.headSha || input.head_sha || input.sha || options.headSha);
  const workspaceId = text(input.workspaceId || options.workspaceId || `github:${repo}`);
  const actor = text(input.actor || options.actor || `github:${repo}`);
  if (!repo || !Number.isInteger(number) || number < 1 || !headSha || !workspaceId) {
    const error = new TypeError('repo, positive integer number, headSha and workspaceId are required');
    error.code = 'PR_SNAPSHOT_REQUIRED';
    throw error;
  }

  const snapshot = {
    sourceType: 'github',
    sourceSubType: 'open_pr',
    repo,
    number,
    title: text(input.title),
    body: text(input.body),
    baseRef: text(input.baseRef || input.base_ref || 'main'),
    headRef: text(input.headRef || input.head_ref),
    headSha,
    actor,
    workspaceId,
    url: text(input.url),
    labels: Array.isArray(input.labels) ? input.labels.map(text).filter(Boolean) : [],
    files: normalizeFiles(input.files),
    checks: normalizeChecks(input.checks),
    receivedAt: text(input.receivedAt || new Date().toISOString()),
    deliveryId: text(input.deliveryId),
  };
  const provenance = buildGitHubProvenance({
    repo,
    number,
    sourceSubType: 'open_pr',
    title: snapshot.title,
    body: snapshot.body,
    url: snapshot.url,
    headSha,
    actor,
    workspaceId,
    timestamp: snapshot.receivedAt,
  }).provenance;
  snapshot.sourceRef = provenance.sourceRef;
  snapshot.provenance = provenance;
  snapshot.contentHash = provenance.contentHash;
  snapshot.targetHash = buildTargetHash(snapshot);
  return Object.freeze(snapshot);
}

function sameTarget(left = {}, right = {}) {
  return Boolean(left.repo && right.repo
    && left.repo === right.repo
    && Number(left.number) === Number(right.number)
    && left.headSha === right.headSha
    && left.targetHash === right.targetHash
    && left.workspaceId === right.workspaceId);
}

module.exports = Object.freeze({
  buildTargetHash,
  normalizePullRequestSnapshot,
  sameTarget,
  sha256,
  stableJson,
});
