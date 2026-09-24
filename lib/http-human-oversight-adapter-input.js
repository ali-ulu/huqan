'use strict';

// #2220: the HTTP ingest oversight input: policy version, case prefix,
// canonical hashing, bounded context and requester/approver resolution.

const crypto = require('node:crypto');
const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
const { isPlainObject } = require('./is-plain-object');

const DEFAULT_POLICY_VERSION = 'http-ingest-approval-v1';
const CASE_PREFIX = 'http-ingest-oversight:';


function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function boundedContext(value) {
  if (!isPlainObject(value)) return null;
  return Object.freeze({ ...value });
}

function contextResolver(runtime, role, details) {
  const resolver = role === 'requester'
    ? runtime?.humanOversightRequesterContext
    : runtime?.humanOversightApproverContext;
  if (typeof resolver === 'function') return boundedContext(resolver(details));
  if (resolver !== undefined) return boundedContext(resolver);
  if (typeof runtime?.humanOversightContextResolver === 'function') {
    return boundedContext(runtime.humanOversightContextResolver({ role, ...details }));
  }
  return null;
}

function buildHttpIngestOversightInput({ approval, runtime = {} } = {}) {
  const snapshot = approval?.context?.snapshot;
  const approvalId = String(approval?.id || '').trim();
  const approvalKey = String(approval?.approvalKey || approvalId).trim();
  const workspaceId = String(snapshot?.workspaceId || approval?.context?.workspaceId || '').trim();
  if (!approvalId || !workspaceId || !isPlainObject(snapshot)) {
    throw new TypeError('HTTP ingest approval snapshot is required for Human Oversight');
  }

  const sourceType = String(snapshot.sourceType || '').trim();
  const sourceRef = String(snapshot.sourceRef || approvalKey).trim();
  const snapshotHash = String(snapshot.snapshotHash || '').trim();
  const inputHash = snapshotHash || hashValue({
    workspaceId,
    sourceType,
    sourceRef,
    idempotencyKey: String(snapshot.idempotencyKey || '').trim(),
  });
  const policyVersion = String(
    approval?.policy?.gate?.metadata?.policyVersion
      || approval?.policy?.approvalVersion
      || DEFAULT_POLICY_VERSION,
  ).slice(0, 160);
  const firewallVersion = String(
    approval?.policy?.gate?.metadata?.firewallVersion || AGENT_ACTION_FIREWALL_VERSION,
  ).slice(0, 160);
  const actionFingerprint = `http-ingest-action:${hashValue({
    approvalId,
    approvalKey,
    workspaceId,
    inputHash,
    policyVersion,
    firewallVersion,
  })}`;
  const action = {
    actionFingerprint,
    workspaceId,
    connectorRef: 'http:ingest',
    resourceRef: approvalKey,
    policyVersion,
    firewallVersion,
    requestedVerdict: 'review',
    requestedEffect: 'execute:http.ingest',
    actionType: 'http_ingest_approval',
    toolName: 'http.ingest',
    target: sourceRef,
    agentId: '',
    evidenceRefs: [approvalId, snapshotHash].filter(Boolean),
    provenanceRefs: [sourceRef].filter(Boolean),
    evidenceDigest: hashValue({ actionFingerprint, workspaceId, inputHash }),
  };
  const requesterDetails = {
    approvalId,
    approvalKey,
    workspaceId,
    snapshotHash,
    sourceType,
    sourceRef,
    action,
  };
  return Object.freeze({
    caseId: `${CASE_PREFIX}${approvalId}`,
    action: Object.freeze(action),
    requesterContext: contextResolver(runtime, 'requester', requesterDetails),
    firewallRequest: Object.freeze({
      surface: 'http-ingest-approval',
      tool: 'http.ingest',
      action: 'ingest',
      context: Object.freeze({ workspaceId, approvalId, source: 'http-ingest-approval' }),
    }),
  });
}

function buildHttpApproverContext(runtime, details) {
  return contextResolver(runtime, 'approver', details);
}

module.exports = {
  CASE_PREFIX,
  buildHttpApproverContext,
  buildHttpIngestOversightInput,
  hashValue,
};
