'use strict';

// Receiver-owned deployment authority. Never read this configuration from an
// action envelope or provenance supplied by an agent.
const fs = require('node:fs');
const { isPlainObject } = require('./is-plain-object');
const { verifyAgentIdentityCardSignature } = require('./external-action-identity-signing');
const MAX_BYTES = 64 * 1024;
const REASON = 'agent_human_sponsor_invalid';

function productionIdentityRequired(options = {}) {
  return [process.env.NODE_ENV, options.environment?.NODE_ENV]
    .some(value => String(value || '').trim().toLowerCase() === 'production');
}

function text(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096;
}

function readSponsorAuthority(options = {}) {
  if (options.humanSponsorAuthority !== undefined) return options.humanSponsorAuthority;
  const environment = options.environment || process.env;
  const target = environment.HUQAN_HUMAN_SPONSOR_AUTHORITY;
  if (!text(target)) throw new Error(REASON);
  const fd = fs.openSync(target, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(REASON);
    const raw = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < raw.length) {
      const count = fs.readSync(fd, raw, length, raw.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error(REASON);
    return JSON.parse(raw.subarray(0, length).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function authorityFor(options) {
  const authority = readSponsorAuthority(options);
  if (!isPlainObject(authority) || authority.schemaVersion !== 'huqan.human-sponsor-authority.v1'
      || !Array.isArray(authority.principals) || authority.principals.length > 128
      || authority.principals.some(p => !isPlainObject(p) || !text(p.actorId))
      || new Set(authority.principals.map(p => p.actorId)).size !== authority.principals.length) {
    throw new Error(REASON);
  }
  return authority;
}

function principalFor(authority, actorId, workspaceId, capability) {
  const principal = authority.principals.find(p => p.actorId === actorId);
  if (!principal || principal.kind !== 'human' || principal.status !== 'active'
      || actorId === 'unattested' || !Array.isArray(principal.workspaceIds)
      || !principal.workspaceIds.includes(workspaceId)
      || !Array.isArray(principal.capabilities) || !principal.capabilities.includes(capability)) {
    throw new Error(REASON);
  }
  return principal;
}

function verifyHumanSponsor(card, envelope, options = {}) {
  try {
    const authority = authorityFor(options);
    const principal = principalFor(authority, card.ownerActorId, card.workspaceId, envelope.kind);
    // A key trusted for another human must not be able to impersonate this one.
    if (card.onBehalfOf !== card.ownerActorId || !Array.isArray(principal.publicKeys)
        || !principal.publicKeys.some(key => typeof key === 'string'
          && verifyAgentIdentityCardSignature(card, envelope.identityCardSignature, key))) {
      throw new Error(REASON);
    }
    return Object.freeze({ actorId: principal.actorId, verified: true,
      workspaceId: card.workspaceId, capability: envelope.kind });
  } catch (_) {
    return null;
  }
}

function backgroundSponsorship(source, workspaceId, options = {}) {
  if (!productionIdentityRequired(options)) return null;
  try {
    const authority = authorityFor(options);
    const grants = authority.background;
    if (!Array.isArray(grants)) throw new Error(REASON);
    const matches = grants.filter(grant => isPlainObject(grant)
      && grant.source === source && grant.workspaceId === workspaceId);
    if (matches.length !== 1) throw new Error(REASON);
    const grant = matches[0];
    if (text(grant.actorId)) {
      const principal = principalFor(authority, grant.actorId, workspaceId, 'memory_mutation');
      return { actorId: principal.actorId, verified: true, workspaceId,
        capability: 'memory_mutation', source };
    }
    if (grant.mode === 'unattended' && text(grant.justification)) {
      return { verified: false, mode: 'unattended', justification: grant.justification,
        workspaceId, capability: 'memory_mutation', source };
    }
  } catch (_) {
    // Fail below with a stable reason, without leaking deployment paths/keys.
  }
  throw new Error('background_human_sponsor_required');
}

module.exports = { productionIdentityRequired, verifyHumanSponsor, backgroundSponsorship };
