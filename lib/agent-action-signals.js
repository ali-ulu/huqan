'use strict';

// Agent action signal extraction, moved verbatim from
// lib/agent-action-firewall.js (#2197): shared constants plus the pure
// shaping that turns a raw action into bounded signals (tool names, action
// text, fingerprints, metadata). Leaf module: only crypto and the automation
// vocabulary below it, so every firewall layer depends downward on this one.

const crypto = require('crypto');
const {
  AUTOMATION_SAFETY_DECISIONS,
} = require('./automation-safety-gate/automation-safety-vocabulary');

const AGENT_ACTION_FIREWALL_VERSION = 'AAFW-v1.0.0';
const INTERNAL_ACTION_CAPABILITY = Symbol('huqan-firewall-receiver-owned-internal-action');

// Every structured operation field the firewall projects into AB5 is clipped to
// this many characters (lib/agent-action-firewall.js). Named here so the
// evidence builder and the projection cannot drift apart (#3618).
const MAX_OPERATION_FIELD_CHARS = 512;

const SAFE_READ_TOOLS = new Set([
  'ask',
  'verify',
  'reason',
  'compare',
  'dream',
  'plan',
]);

const AGENT_ACTION_FIREWALL_DECISIONS = Object.freeze({
  ALLOW: AUTOMATION_SAFETY_DECISIONS.ALLOW,
  REVIEW: AUTOMATION_SAFETY_DECISIONS.REVIEW,
  BLOCK: AUTOMATION_SAFETY_DECISIONS.BLOCK,
  DRY_RUN_ONLY: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
});

const STRUCTURED_ACTION_KEYS = Object.freeze([
  'action',
  'operation',
  'operationType',
  'intent',
  'command',
  'cmd',
  'shell',
  'script',
  'exec',
  'target',
  'deploy',
  'release',
  'merge',
  'workflow',
  'branch',
  'baseBranch',
]);

// The structured fields the firewall value-clips while building the projection
// it hands to AB5 (lib/agent-action-firewall.js). It is deliberately narrower
// than STRUCTURED_ACTION_KEYS: `operation` and `deploy` are structured keys
// the projection copies unclipped, so evidence must never claim a clip for
// them. Both modules iterate this one list, so the projection and the evidence
// cannot drift apart.
const CLIPPED_OPERATION_KEYS = Object.freeze([
  'operationType',
  'action',
  'intent',
  'target',
  'branch',
  'baseBranch',
  'command',
  'cmd',
  'shell',
  'script',
  'exec',
]);

const AUTOMATION_MARKERS = Object.freeze([
  'deploy',
  'release',
  'merge',
  'push',
  'force push',
  'force_push',
  'rebase',
  'reset hard',
  'delete branch',
  'branch protection',
  'workflow dispatch',
  'skip ci',
  'bypass ci',
  'auto merge',
  'automerge',
  'secret persistence',
  'token persistence',
  'repo settings',
  'destructive cleanup',
  'purge',
  'wipe',
]);

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase();
}

function isSafeReadTool(tool) {
  if (SAFE_READ_TOOLS.has(tool)) return true;
  const parts = tool.split('.');
  return parts.length === 2
    && (parts[0] === 'axiom' || parts[0] === 'huqan')
    && SAFE_READ_TOOLS.has(parts[1]);
}

function inputKeys(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.keys(input).sort().slice(0, 32);
}

function actionText({ tool, action, input }) {
  const values = [tool, action];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of STRUCTURED_ACTION_KEYS) {
      const value = input[key];
      if (typeof value === 'string') values.push(value.slice(0, 256));
      else if (value && typeof value === 'object' && key !== 'target') values.push(JSON.stringify(value).slice(0, 256));
    }
  }
  return values.filter(Boolean).join(' ').toLowerCase();
}

function hasAutomationMarker(value) {
  const text = String(value || '').toLowerCase();
  return AUTOMATION_MARKERS.some(marker => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_-]+/g, '[ _-]+');
    return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s|[/:])`, 'i').test(text);
  });
}

function hasStructuredAction(input) {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input)
    && STRUCTURED_ACTION_KEYS.some(key => Object.prototype.hasOwnProperty.call(input, key)));
}

function fingerprint({ surface, tool, action, workspaceId, target }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ surface, tool, action, workspaceId, target }))
    .digest('hex')
    .slice(0, 24);
}

// A trimmed string cut to `max`, or `fallback` when there is none. Not
// firstText: that one returns the first non-empty *candidate*, so a length
// passed to it was returned as text ('64') whenever the field was missing.
function boundedText(value, fallback, max) {
  const text = typeof value === 'string' ? value.trim().slice(0, max) : '';
  return text || fallback;
}

function summarizeGoalIntegrity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const goalFingerprint = boundedText(value.goalFingerprint, '', 64);
  const goalScopeId = boundedText(value.goalScopeId, '', 64);
  if (!goalFingerprint || !goalScopeId) return null;
  return {
    version: boundedText(value.version, '', 64),
    goalFingerprint,
    goalScopeId,
    workspaceId: boundedText(value.workspaceId, 'default', 128),
    sourceClass: boundedText(value.sourceClass, 'caller_goal', 64),
    policyVersion: boundedText(value.policyVersion, '', 64),
    immutable: value.immutable === true,
  };
}

// Field-level evidence for a firewall decision (#3618, R53).
//
// The firewall reports which keys it saw (`inputKeys`) and a one-way action
// fingerprint, but never the fields it value-clipped while shaping the input:
// `lib/agent-action-firewall.js` cuts every structured operation field to 512
// chars, so the decision that follows was made on a *bounded* copy and the
// trail cannot show that a clip happened. This returns `{propertyPath,
// valueBefore, valueAfter}` rows for exactly those fields -- before/after as
// lengths, never the value -- so a reader can tell a decision measured the
// whole field from one that measured a clip.
//
// Bounded by construction: one row per clipped key at most, and each row is
// only two integers plus a path. Empty for a missing or non-object input, so
// allow/read paths that carry no operation object stay unchanged.
function inputFieldEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const rows = [];
  for (const key of CLIPPED_OPERATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'string' || value.length <= MAX_OPERATION_FIELD_CHARS) continue;
    rows.push(Object.freeze({
      propertyPath: `input.${key}`,
      valueBefore: String(value.length),
      valueAfter: String(MAX_OPERATION_FIELD_CHARS),
    }));
  }
  return rows;
}

function buildMetadata({ surface, tool, action, input, context, target }) {
  const workspaceId = firstText(context?.workspaceId, context?.metadata?.workspaceId, 'default') || 'default';
  const goalIntegrity = summarizeGoalIntegrity(context?.goalIntegrity);
  return {
    workspaceId,
    surface: firstText(surface, 'agent'),
    tool: normalizeToolName(tool),
    action: firstText(action, input?.action, input?.operationType, input?.operation, ''),
    actionId: fingerprint({
      surface: firstText(surface, 'agent'),
      tool: normalizeToolName(tool),
      action: firstText(action, input?.action, input?.operationType, input?.operation, ''),
      workspaceId,
      target,
    }),
    inputKeys: inputKeys(input),
    firewallVersion: AGENT_ACTION_FIREWALL_VERSION,
    ...(goalIntegrity ? { goalIntegrity } : {}),
  };
}

module.exports = {
  AGENT_ACTION_FIREWALL_DECISIONS,
  AGENT_ACTION_FIREWALL_VERSION,
  AUTOMATION_MARKERS,
  CLIPPED_OPERATION_KEYS,
  INTERNAL_ACTION_CAPABILITY,
  MAX_OPERATION_FIELD_CHARS,
  SAFE_READ_TOOLS,
  STRUCTURED_ACTION_KEYS,
  actionText,
  buildMetadata,
  fingerprint,
  firstText,
  hasAutomationMarker,
  hasStructuredAction,
  inputFieldEvidence,
  inputKeys,
  isSafeReadTool,
  normalizeToolName,
  summarizeGoalIntegrity,
};
