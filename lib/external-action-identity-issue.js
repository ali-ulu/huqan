'use strict';

// `huqan-gate identity issue` -- mint a capability card an operator hands to a
// gate call (#2505). The card's shape and its enforcement live in
// external-action-identity-card.js; this module only turns operator-supplied
// arguments into that shape, validates it through the same normalizer the guard
// uses, and (when asked) signs it. It never invents authority: the operator
// names the owner, workspace and capabilities, and a card that does not
// normalize is refused rather than written.
//
// Before this, the only way to produce a card was hand-written JSON in a test
// (see test/external-action-hook-cli.test.js). That is why a fresh install
// blocks every action with `agent_identity_card_required` and no obvious next
// step: the required artifact had no issuance path.

const fs = require('node:fs');
const path = require('node:path');
const {
  AGENT_IDENTITY_CARD_SCHEMA_VERSION,
  CAPABILITY_VOCABULARY,
  identityRefFor,
  normalizeAgentIdentityCard,
} = require('./external-action-identity-card');
const { generateIdentityCardKeyPair, signAgentIdentityCard } = require('./external-action-identity-signing');
const { argumentValue } = require('./gate-hook-input');

// The schema caps a card's life at 24h; the default is half that so a card
// minted for one work session does not silently outlive it.
const DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
}

/**
 * Build the card an operator asked for, or the errors that stop it. `now` is a
 * parameter so the lifetime window is testable without a clock.
 */
function buildIdentityCard(options = {}, now = new Date()) {
  const errors = [];
  const agentId = String(options.agentId || '').trim();
  const agentName = String(options.agentName || options.agentId || '').trim();
  const ownerActorId = String(options.ownerActorId || '').trim();
  const workspaceId = String(options.workspaceId || 'default').trim();
  const capabilities = options.capabilities || [];
  if (!agentId) errors.push('agent_id_required');
  if (!ownerActorId) errors.push('owner_actor_id_required');
  if (!capabilities.length) errors.push('capabilities_required');

  const issuedAt = options.issuedAt ? parseInstant(options.issuedAt) : now;
  if (!issuedAt) errors.push('issued_at_invalid');
  let expiresAt = options.expiresAt ? parseInstant(options.expiresAt) : null;
  if (options.expiresAt && !expiresAt) errors.push('expires_at_invalid');
  if (!expiresAt && issuedAt) {
    const lifetime = Number.isFinite(options.lifetimeMs) ? options.lifetimeMs : DEFAULT_LIFETIME_MS;
    expiresAt = new Date(issuedAt.getTime() + lifetime);
  }
  if (issuedAt && expiresAt) {
    if (expiresAt.getTime() <= issuedAt.getTime()) errors.push('expires_before_issued');
    if (expiresAt.getTime() - issuedAt.getTime() > MAX_LIFETIME_MS) errors.push('lifetime_exceeds_24h');
  }

  const unknown = capabilities.filter((capability) => !CAPABILITY_VOCABULARY.includes(capability));
  if (unknown.length) errors.push(`capability_unknown:${unknown.join(',')}`);
  if (errors.length) return { card: null, errors };

  const delegationChain = options.delegationChain && options.delegationChain.length
    ? options.delegationChain
    : [agentId];
  const { card, errors: normalizeErrors } = normalizeAgentIdentityCard({
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    agentId,
    agentName,
    agentVersion: String(options.agentVersion || '').trim(),
    ownerActorId,
    onBehalfOf: String(options.onBehalfOf || ownerActorId).trim(),
    workspaceId,
    capabilities,
    delegationChain,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return { card, errors: normalizeErrors };
}

function writeExclusive(target, contents) {
  // `wx` refuses an existing file: an operator who points issuance at a live
  // card path should learn that before a key or card is overwritten.
  fs.writeFileSync(target, contents, { flag: 'wx' });
}

function issueIdentityCard() {
  const keyPairDirectory = argumentValue('--generate-keypair');
  const result = { command: 'identity', action: 'issue', ok: false };

  if (keyPairDirectory) {
    try {
      fs.mkdirSync(keyPairDirectory, { recursive: true });
      const keyPair = generateIdentityCardKeyPair();
      const privatePath = path.join(keyPairDirectory, 'identity-card-private.pem');
      const publicPath = path.join(keyPairDirectory, 'identity-card-public.pem');
      writeExclusive(privatePath, keyPair.privateKeyPem);
      writeExclusive(publicPath, keyPair.publicKeyPem);
      result.keyPair = { privateKeyPath: privatePath, publicKeyPath: publicPath, algorithm: keyPair.algorithm };
    } catch (error) {
      result.errors = [String((error && error.message) || error)];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    // A key-pair request on its own is a complete command; issuing a card is
    // a separate, explicit call.
    if (!argumentValue('--out')) {
      result.ok = true;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }
  }

  const lifetimeHours = argumentValue('--lifetime-hours');
  const { card, errors } = buildIdentityCard({
    agentId: argumentValue('--agent-id'),
    agentName: argumentValue('--agent-name'),
    agentVersion: argumentValue('--agent-version'),
    ownerActorId: argumentValue('--owner'),
    onBehalfOf: argumentValue('--on-behalf-of'),
    workspaceId: argumentValue('--workspace-id'),
    capabilities: splitList(argumentValue('--capabilities')),
    delegationChain: splitList(argumentValue('--delegation-chain')),
    issuedAt: argumentValue('--issued-at'),
    expiresAt: argumentValue('--expires-at'),
    ...(lifetimeHours ? { lifetimeMs: Number(lifetimeHours) * 60 * 60 * 1000 } : {}),
  });
  if (!card) {
    result.errors = errors;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const outPath = argumentValue('--out');
  if (!outPath) {
    result.errors = ['out_required'];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    writeExclusive(outPath, `${JSON.stringify(card, null, 2)}\n`);
  } catch (error) {
    result.errors = [String((error && error.message) || error)];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  result.card = card;
  result.cardPath = path.resolve(outPath);
  result.identityRef = identityRefFor(card.workspaceId, card.agentId);
  result.capabilities = card.capabilities;
  result.expiresAt = card.expiresAt;

  const signKeyPath = argumentValue('--sign-key');
  if (signKeyPath) {
    const signature = signAgentIdentityCard(card, fs.readFileSync(signKeyPath, 'utf8'));
    if (!signature) {
      result.errors = ['signing_failed'];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const signaturePath = argumentValue('--out-signature') || `${outPath}.sig.json`;
    try {
      writeExclusive(signaturePath, `${JSON.stringify(signature, null, 2)}\n`);
    } catch (error) {
      result.errors = [String((error && error.message) || error)];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    result.signaturePath = path.resolve(signaturePath);
  }

  result.ok = true;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 0;
}

module.exports = {
  DEFAULT_LIFETIME_MS,
  MAX_LIFETIME_MS,
  buildIdentityCard,
  issueIdentityCard,
};
