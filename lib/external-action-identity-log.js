'use strict';

/**
 * Faz C (#1769) criterion 3 — "list every action taken by a given identity".
 *
 * Read-only projection over the external action receipt trail written by
 * lib/external-action-receipt.js. This module never writes: it opens no graph
 * and calls no admission sink, so it stays outside the mutation-admission
 * boundary entirely.
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { identityRefFor } = require('./external-action-identity');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 10000;

function parseReceiptLines(raw) {
  const receipts = [];
  let skipped = 0;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.receiptId) receipts.push(parsed);
      else skipped += 1;
    } catch (_) {
      skipped += 1;
    }
  }
  return { receipts, skipped };
}

/**
 * A receipt written before identity persistence existed has no
 * `metadata.identity`. Rather than drop it from the answer, project the legacy
 * transport fields into the same shape and mark it unattested — an incomplete
 * history is still history, and silently omitting it would make the query lie.
 */
function receiptIdentity(receipt) {
  const identity = receipt.metadata?.identity;
  if (identity && typeof identity === 'object') return identity;
  const agentId = String(receipt.agentId || receipt.actor || '');
  const workspaceId = String(receipt.workspaceId || 'default');
  return {
    attested: false,
    identityRef: agentId ? identityRefFor(workspaceId, agentId) : '',
    identityHash: '',
    agentId,
    agentName: String(receipt.actor || ''),
    ownerActorId: '',
    onBehalfOf: '',
    workspaceId,
    capabilities: [],
    delegationChain: agentId ? [agentId] : [],
    sessionId: String(receipt.metadata?.sessionId || ''),
    turnId: String(receipt.metadata?.turnId || ''),
    legacy: true,
  };
}

function timestamp(receipt) {
  const value = Date.parse(receipt.createdAt);
  return Number.isFinite(value) ? value : null;
}

function boundary(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matches(receipt, identity, filter) {
  if (filter.identityRef && identity.identityRef !== filter.identityRef) return false;
  if (filter.identityHash && identity.identityHash !== filter.identityHash) return false;
  if (filter.agentId && identity.agentId !== filter.agentId) return false;
  if (filter.ownerActorId && identity.ownerActorId !== filter.ownerActorId) return false;
  if (filter.onBehalfOf && identity.onBehalfOf !== filter.onBehalfOf) return false;
  if (filter.workspaceId && identity.workspaceId !== filter.workspaceId) return false;
  if (filter.sessionId && identity.sessionId !== filter.sessionId) return false;
  if (filter.decision && receipt.decision !== filter.decision) return false;
  if (filter.attested !== undefined && Boolean(identity.attested) !== Boolean(filter.attested)) return false;
  const at = timestamp(receipt);
  const since = boundary(filter.since);
  const until = boundary(filter.until);
  if (since !== null && (at === null || at < since)) return false;
  if (until !== null && (at === null || at > until)) return false;
  return true;
}

function bump(counter, key) {
  if (!key) return;
  counter[key] = (counter[key] || 0) + 1;
}

function summarize(entries) {
  const byDecision = {};
  const byToolKind = {};
  const byReceiptKind = {};
  const identityRefs = new Set();
  let attested = 0;
  let firstAt = null;
  let lastAt = null;
  for (const entry of entries) {
    bump(byDecision, entry.receipt.decision);
    bump(byToolKind, entry.receipt.metadata?.toolKind);
    bump(byReceiptKind, entry.receipt.receiptKind);
    if (entry.identity.identityRef) identityRefs.add(entry.identity.identityRef);
    if (entry.identity.attested) attested += 1;
    const at = entry.receipt.createdAt;
    if (at && (!firstAt || at < firstAt)) firstAt = at;
    if (at && (!lastAt || at > lastAt)) lastAt = at;
  }
  return {
    total: entries.length,
    attested,
    unattested: entries.length - attested,
    identityRefs: [...identityRefs].sort(),
    byDecision,
    byToolKind,
    byReceiptKind,
    firstAt,
    lastAt,
  };
}

/**
 * Query the receipt trail for one identity.
 *
 * Accepts either a pre-read `lines` string (tests, piped input) or a `path` /
 * environment-resolved receipt log. Results are ordered oldest-first and
 * bounded by `limit`; `truncated` reports whether the bound cut the answer, so
 * a caller can tell "this agent took 12 actions" apart from "here are the
 * first 12 of many".
 */
function queryExternalActionsByIdentity(filter = {}) {
  const limit = Number.isInteger(filter.limit) && filter.limit > 0
    ? Math.min(filter.limit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const source = typeof filter.lines === 'string'
    ? { raw: filter.lines, path: null }
    : readReceiptFile(filter);
  const { receipts, skipped } = parseReceiptLines(source.raw);

  const matched = [];
  for (const receipt of receipts) {
    const identity = receiptIdentity(receipt);
    if (matches(receipt, identity, filter)) matched.push({ receipt, identity });
  }
  matched.sort((left, right) => String(left.receipt.createdAt).localeCompare(String(right.receipt.createdAt)));

  const page = matched.slice(0, limit);
  return Object.freeze({
    ok: true,
    path: source.path,
    scanned: receipts.length,
    skippedLines: skipped,
    matched: matched.length,
    truncated: matched.length > page.length,
    actions: page.map(entry => Object.freeze({
      receiptId: entry.receipt.receiptId,
      receiptKind: entry.receipt.receiptKind,
      decision: entry.receipt.decision,
      status: entry.receipt.status,
      reason: entry.receipt.reason,
      riskScore: entry.receipt.riskScore,
      createdAt: entry.receipt.createdAt,
      invocationId: entry.receipt.admissionId,
      toolName: entry.receipt.metadata?.toolName || '',
      toolKind: entry.receipt.metadata?.toolKind || '',
      identity: entry.identity,
    })),
    summary: summarize(matched),
  });
}

function readReceiptFile(filter) {
  const target = path.resolve(filter.path || defaultExternalActionReceiptPath(filter.environment || process.env));
  try {
    return { raw: fs.readFileSync(target, 'utf8'), path: target };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { raw: '', path: target };
    throw error;
  }
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  queryExternalActionsByIdentity,
  parseExternalActionReceiptLines: parseReceiptLines,
  externalActionReceiptIdentity: receiptIdentity,
};
