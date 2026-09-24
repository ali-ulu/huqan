'use strict';

// #2215: the agent identity card: schema, limits, reasons, capability
// vocabulary, normalization and the card hash.

const crypto = require('node:crypto');
const { stableStringify } = require('./receipt/canonical-receipt');
const { isPlainObject } = require('./is-plain-object');
const { EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { EMERGENCY_STOP_REASON } = require('./emergency-stop');

const AGENT_IDENTITY_CARD_SCHEMA_VERSION = 'huqan.agent-identity-card.v1';
const CAPABILITY_WILDCARD = '*';
const UNATTESTED_OWNER = 'unattested';

const MAX_FIELD_BYTES = 256;
const MAX_CAPABILITIES = 32;
const MAX_DELEGATION_CHAIN = 16;
const MAX_CARD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const IDENTITY_REASONS = Object.freeze({
  EMERGENCY_STOPPED: EMERGENCY_STOP_REASON,
  ATTESTED: 'agent_identity_attested',
  UNATTESTED: 'agent_identity_unattested',
  CARD_REQUIRED: 'agent_identity_card_required',
  CARD_INVALID: 'agent_identity_card_invalid',
  WORKSPACE_MISMATCH: 'agent_identity_workspace_mismatch',
  AGENT_MISMATCH: 'agent_identity_agent_mismatch',
  NOT_YET_VALID: 'agent_identity_card_not_yet_valid',
  EXPIRED: 'agent_identity_card_expired',
  CAPABILITY_NOT_GRANTED: 'agent_identity_capability_not_granted',
  TASK_SCOPE_MISMATCH: 'agent_identity_task_scope_mismatch',
});

const CAPABILITY_VOCABULARY = Object.freeze([
  CAPABILITY_WILDCARD,
  ...Object.values(EXTERNAL_ACTION_KINDS),
]);

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value.trim(), 'utf8') <= MAX_FIELD_BYTES
    ? value.trim()
    : '';
}

function instant(value) {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : '';
}

function uniqueList(value, limit) {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) return null;
  const items = value.map(text);
  if (items.some(item => !item)) return null;
  return new Set(items).size === items.length ? items : null;
}

/**
 * Validate a supplied capability card. Returns `{ card, errors }` — `card` is
 * null whenever `errors` is non-empty, so a malformed card can never be
 * mistaken for an attested one.
 */
function normalizeAgentIdentityCard(input) {
  const errors = [];
  if (!isPlainObject(input)) return { card: null, errors: ['identity_card_not_an_object'] };

  const schemaVersion = text(input.schemaVersion);
  if (schemaVersion !== AGENT_IDENTITY_CARD_SCHEMA_VERSION) errors.push('identity_card_schema_version_invalid');

  const agentId = text(input.agentId);
  const agentName = text(input.agentName);
  const ownerActorId = text(input.ownerActorId);
  const workspaceId = text(input.workspaceId);
  const issuedAt = instant(input.issuedAt);
  if (!agentId) errors.push('identity_card_agent_id_missing');
  if (!agentName) errors.push('identity_card_agent_name_missing');
  if (!ownerActorId) errors.push('identity_card_owner_actor_id_missing');
  if (!workspaceId) errors.push('identity_card_workspace_id_missing');
  if (!issuedAt) errors.push('identity_card_issued_at_invalid');

  const capabilities = uniqueList(input.capabilities, MAX_CAPABILITIES);
  if (!capabilities) errors.push('identity_card_capabilities_invalid');
  else if (capabilities.some(capability => !CAPABILITY_VOCABULARY.includes(capability))) {
    errors.push('identity_card_capability_unknown');
  }

  const chainSupplied = input.delegationChain !== undefined && input.delegationChain !== null;
  const delegationChain = chainSupplied
    ? uniqueList(input.delegationChain, MAX_DELEGATION_CHAIN)
    : (agentId ? [agentId] : null);
  if (!delegationChain) errors.push('identity_card_delegation_chain_invalid');
  else if (agentId && delegationChain.at(-1) !== agentId) errors.push('identity_card_delegation_chain_not_terminal');

  const expiresSupplied = input.expiresAt !== undefined && input.expiresAt !== null;
  const expiresAt = expiresSupplied ? instant(input.expiresAt) : '';
  if (!expiresSupplied) errors.push('identity_card_expires_at_missing');
  else if (!expiresAt) errors.push('identity_card_expires_at_invalid');
  else if (Date.parse(expiresAt) - Date.parse(issuedAt) > MAX_CARD_LIFETIME_MS) errors.push('identity_card_lifetime_exceeded');
  if (issuedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    errors.push('identity_card_expires_before_issued');
  }

  // #2505 C: optional task/run binding. A card without `taskScope` works
  // exactly as before; a card that carries one grants only inside that scope
  // (least privilege). `runId` binds to the envelope session, `taskId` to a
  // caller-supplied task — at least one must be present when supplied.
  const scopeSupplied = input.taskScope !== undefined && input.taskScope !== null;
  let taskScope = null;
  if (scopeSupplied) {
    if (!isPlainObject(input.taskScope)) errors.push('identity_card_task_scope_invalid');
    else {
      const taskId = text(input.taskScope.taskId);
      const runId = text(input.taskScope.runId);
      if (!taskId && !runId) errors.push('identity_card_task_scope_invalid');
      else taskScope = Object.freeze({ taskId: taskId || null, runId: runId || null });
    }
  }

  if (errors.length) return { card: null, errors };

  return {
    card: Object.freeze({
      schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
      agentId,
      agentName,
      agentVersion: text(input.agentVersion),
      ownerActorId,
      onBehalfOf: text(input.onBehalfOf) || ownerActorId,
      workspaceId,
      capabilities: Object.freeze(capabilities),
      delegationChain: Object.freeze(delegationChain),
      issuedAt,
      expiresAt: expiresAt || null,
      // Present only when bound: an unscoped card keeps its exact canonical
      // hash, so existing signatures and identity hashes do not move.
      ...(taskScope ? { taskScope } : {}),
    }),
    errors: [],
  };
}

function identityRefFor(workspaceId, agentId) {
  return `agent:${workspaceId}:${agentId}`;
}

/**
 * The hash covers only the card's authority-bearing fields, so the same card
 * always yields the same identityHash regardless of which invocation carried
 * it. Session/turn are invocation context, not identity, and stay out.
 */
function computeIdentityCardHash(core) {
  return crypto.createHash('sha256').update(stableStringify(core), 'utf8').digest('hex');
}

module.exports = {
  AGENT_IDENTITY_CARD_SCHEMA_VERSION,
  CAPABILITY_VOCABULARY,
  CAPABILITY_WILDCARD,
  IDENTITY_REASONS,
  UNATTESTED_OWNER,
  computeIdentityCardHash,
  identityRefFor,
  normalizeAgentIdentityCard,
  text,
};
