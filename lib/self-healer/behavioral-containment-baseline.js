'use strict';

// #2217: behavioral containment limits, decisions and deviation codes, and the
// normalized baseline and observation the assessment compares.

const crypto = require('node:crypto');
const { normalizeWorkspaceId } = require('../workspace-id');
const { isPlainObject } = require('../is-plain-object');

const BEHAVIORAL_CONTAINMENT_VERSION = 'asi10-behavioral-v0.1.0';
const MAX_LIST_ITEMS = 16;
const MAX_TOKEN_LENGTH = 80;
const MAX_SEQUENCE_LENGTH = 64;
const DEFAULT_REPEATED_ANOMALY_THRESHOLD = 3;

const BEHAVIORAL_DECISIONS = Object.freeze({
  OBSERVE: 'observe',
  REQUIRE_REVIEW: 'require_review',
  BLOCK: 'block',
  QUARANTINE: 'quarantine',
});

const BEHAVIORAL_DEVIATION_CODES = Object.freeze({
  BASELINE_MISSING: 'baseline_missing',
  OBSERVATION_INCOMPLETE: 'observation_incomplete',
  WORKSPACE_DRIFT: 'workspace_drift',
  IDENTITY_DRIFT: 'identity_drift',
  UNEXPECTED_TOOL: 'unexpected_tool',
  UNEXPECTED_ACTION: 'unexpected_action',
  UNEXPECTED_CONNECTOR: 'unexpected_connector',
  UNEXPECTED_TARGET: 'unexpected_target',
  UNEXPECTED_EGRESS: 'unexpected_egress',
  UNEXPECTED_DELEGATION: 'unexpected_delegation',
  REPEATED_ANOMALY: 'repeated_anomaly',
});

function normalizeString(value, fallback = '') {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? normalized.slice(0, MAX_TOKEN_LENGTH) : fallback;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => normalizeString(item).toLowerCase())
    .filter(Boolean))].slice(0, MAX_LIST_ITEMS);
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function hasArrayField(source, keys) {
  return keys.some((key) => hasOwn(source, key) && Array.isArray(source[key]));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprint(value) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  if (/^[a-f0-9]{16,128}$/i.test(normalized)) return normalized.toLowerCase();
  return stableHash({ value: normalized }).slice(0, 32);
}

function boundedInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(MAX_SEQUENCE_LENGTH, Math.floor(parsed)));
}

function freezeList(value) {
  return Object.freeze([...value]);
}

function createBehavioralBaseline(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const goalFingerprint = fingerprint(source.goalFingerprint || source.goal);
  const scope = {
    goalFingerprint,
    capabilities: normalizeList(source.capabilities),
    tools: normalizeList(source.tools ?? source.allowedTools),
    connectors: normalizeList(source.connectors ?? source.allowedConnectors),
    targetClasses: normalizeList(source.targetClasses ?? source.allowedTargetClasses),
    egressClasses: normalizeList(source.egressClasses ?? source.egress),
    delegation: normalizeList(source.delegation ?? source.allowedDelegation),
  };
  const declared = [
    Boolean(goalFingerprint),
    hasArrayField(source, ['capabilities']),
    hasArrayField(source, ['tools', 'allowedTools']),
    hasArrayField(source, ['connectors', 'allowedConnectors']),
    hasArrayField(source, ['targetClasses', 'allowedTargetClasses']),
    hasArrayField(source, ['egressClasses', 'egress']),
    hasArrayField(source, ['delegation', 'allowedDelegation']),
  ];
  const workspaceId = normalizeWorkspaceId(source.workspaceId);
  const agentId = normalizeString(source.agentId);
  const canonical = {
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    workspaceId,
    agentId,
    scope,
  };
  const baselineHash = stableHash(canonical).slice(0, 32);
  return Object.freeze({
    ...canonical,
    scope: Object.freeze({
      ...scope,
      capabilities: freezeList(scope.capabilities),
      tools: freezeList(scope.tools),
      connectors: freezeList(scope.connectors),
      targetClasses: freezeList(scope.targetClasses),
      egressClasses: freezeList(scope.egressClasses),
      delegation: freezeList(scope.delegation),
    }),
    baselineHash,
    complete: Boolean(agentId) && declared.every(Boolean),
  });
}

function normalizeObservation(input = {}) {
  const source = isPlainObject(input) ? input : {};
  return {
    workspaceId: normalizeWorkspaceId(source.workspaceId),
    agentId: normalizeString(source.agentId),
    tool: normalizeString(source.tool).toLowerCase(),
    action: normalizeString(source.action).toLowerCase(),
    connector: normalizeString(source.connector).toLowerCase(),
    targetClass: normalizeString(source.targetClass).toLowerCase(),
    egressClass: normalizeString(source.egressClass).toLowerCase(),
    delegationClass: normalizeString(source.delegationClass).toLowerCase(),
    sequenceLength: boundedInteger(source.sequenceLength),
    sequenceTools: normalizeList(source.sequenceTools),
    repeatedAnomalies: boundedInteger(source.repeatedAnomalies),
  };
}

function sequenceSummary(observation) {
  return Object.freeze({
    length: observation.sequenceLength,
    uniqueTools: freezeList(observation.sequenceTools),
    lastTool: observation.tool || null,
    lastAction: observation.action || null,
  });
}

module.exports = {
  BEHAVIORAL_CONTAINMENT_VERSION,
  BEHAVIORAL_DECISIONS,
  BEHAVIORAL_DEVIATION_CODES,
  DEFAULT_REPEATED_ANOMALY_THRESHOLD,
  MAX_SEQUENCE_LENGTH,
  createBehavioralBaseline,
  normalizeObservation,
  sequenceSummary,
  stableHash,
};
