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
 * A value-taking option's argument, or '' when the next token is another
 * option. `--owner --capabilities shell` would otherwise read `--capabilities`
 * as the owner and mint a card attributed to a string that is not an actor.
 */
function optionValue(name) {
  const value = argumentValue(name);
  return typeof value === 'string' && value.startsWith('--') ? '' : value;
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
  // An explicit non-finite lifetime (`--lifetime-hours abc`) is a mistake, not
  // an omission: falling back to the default would report success for a window
  // the operator did not ask for.
  const lifetime = options.lifetimeMs === undefined ? DEFAULT_LIFETIME_MS : options.lifetimeMs;
  const explicitExpiry = Boolean(options.expiresAt);
  if (!explicitExpiry && !Number.isFinite(lifetime)) errors.push('lifetime_invalid');
  let expiresAt = explicitExpiry ? parseInstant(options.expiresAt) : null;
  if (explicitExpiry && !expiresAt) errors.push('expires_at_invalid');
  if (!explicitExpiry && issuedAt && Number.isFinite(lifetime)) {
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

function writeExclusive(target, contents, mode) {
  // `wx` refuses an existing file: an operator who points issuance at a live
  // card path should learn that before a key or card is overwritten. A key is
  // written 0o600 because `wx` stops overwrites, not reads.
  fs.writeFileSync(target, contents, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
}

function writeOutputs(outputs) {
  const written = [];
  try {
    for (const output of outputs) {
      writeExclusive(output.path, output.contents, output.mode);
      written.push(output.path);
    }
    return { error: null };
  } catch (error) {
    // Publication is all-or-nothing: a card left behind by a failed signature
    // write cannot be retried (`wx`) and would look like a usable card.
    for (const target of written) {
      try { fs.rmSync(target, { force: true }); } catch { /* keep the first error */ }
    }
    return { error };
  }
}

function issueIdentityCard() {
  const keyPairDirectory = argumentValue('--generate-keypair');
  const result = { command: 'identity', action: 'issue', ok: false };

  if (keyPairDirectory) {
    const privatePath = path.join(keyPairDirectory, 'identity-card-private.pem');
    const publicPath = path.join(keyPairDirectory, 'identity-card-public.pem');
    try {
      // 0o700 on the directory we create (mkdir ignores the mode for an
      // existing one), 0o600 on the private key: `wx` stops overwrites, not
      // reads by another local account that can traverse the path.
      fs.mkdirSync(keyPairDirectory, { recursive: true, mode: 0o700 });
      const keyPair = generateIdentityCardKeyPair();
      const { error } = writeOutputs([
        { path: privatePath, contents: keyPair.privateKeyPem, mode: 0o600 },
        { path: publicPath, contents: keyPair.publicKeyPem, mode: 0o644 },
      ]);
      if (error) throw error;
      result.keyPair = { privateKeyPath: privatePath, publicKeyPath: publicPath, algorithm: keyPair.algorithm };
    } catch (error) {
      result.errors = [String((error && error.message) || error)];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    // A key-pair request on its own is a complete command; issuing a card is
    // a separate, explicit call.
    if (!optionValue('--out')) {
      result.ok = true;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }
  }

  const lifetimeHours = argumentValue('--lifetime-hours');
  const { card, errors } = buildIdentityCard({
    agentId: optionValue('--agent-id'),
    agentName: optionValue('--agent-name'),
    agentVersion: optionValue('--agent-version'),
    ownerActorId: optionValue('--owner'),
    onBehalfOf: optionValue('--on-behalf-of'),
    workspaceId: optionValue('--workspace-id'),
    capabilities: splitList(argumentValue('--capabilities')),
    delegationChain: splitList(argumentValue('--delegation-chain')),
    issuedAt: optionValue('--issued-at'),
    expiresAt: optionValue('--expires-at'),
    ...(lifetimeHours ? { lifetimeMs: Number(lifetimeHours) * 60 * 60 * 1000 } : {}),
  });
  if (!card) {
    result.errors = errors;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const outPath = optionValue('--out');
  if (!outPath) {
    result.errors = ['out_required'];
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  // Read and sign before writing anything: a missing `--sign-key` must fail
  // before a card exists, and a failed signature write must not leave one
  // behind (a retry would then hit `wx`).
  const outputs = [{ path: outPath, contents: `${JSON.stringify(card, null, 2)}\n` }];
  const signKeyPath = argumentValue('--sign-key');
  if (signKeyPath) {
    let signature;
    try {
      signature = signAgentIdentityCard(card, fs.readFileSync(signKeyPath, 'utf8'));
    } catch (error) {
      result.errors = [String((error && error.message) || error)];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    if (!signature) {
      result.errors = ['signing_failed'];
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const signaturePath = argumentValue('--out-signature') || `${outPath}.sig.json`;
    outputs.push({ path: signaturePath, contents: `${JSON.stringify(signature, null, 2)}\n` });
  }

  const { error } = writeOutputs(outputs);
  if (error) {
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
  if (signKeyPath) result.signaturePath = path.resolve(outputs[1].path);

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
