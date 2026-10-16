'use strict';

// Independent consumer: intentionally no HUQAN imports, only Node built-ins.
const crypto = require('node:crypto');
const fs = require('node:fs');

const EXCHANGE_DOMAIN = 'HUQAN/V5/D6/A2A-EXCHANGE/v1';
const DELEGATION_DOMAIN = 'HUQAN/V5/D6/A2A-DELEGATION/v1';
const REPLAY_DOMAIN = 'HUQAN/V5/D6/A2A-REPLAY/v1';

function canonicalBytes(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return Buffer.from(JSON.stringify(value), 'utf8');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Buffer.from(Object.is(value, -0) ? '0' : JSON.stringify(value), 'utf8');
  }
  if (Array.isArray(value)) {
    return Buffer.from(`[${value.map((entry) => canonicalBytes(entry).toString('utf8')).join(',')}]`, 'utf8');
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const text = Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalBytes(value[key]).toString('utf8')}`
    )).join(',');
    return Buffer.from(`{${text}}`, 'utf8');
  }
  throw new TypeError('unsupported canonical JSON value');
}

function hash(value) {
  return crypto.createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

function findActiveKey(authority, keyReference) {
  const key = authority.keys.find((entry) => entry.keyReference === keyReference);
  if (!key || key.status !== 'active' || key.publicKeySpkiDerBase64 === null) return null;
  return crypto.createPublicKey({
    key: Buffer.from(key.publicKeySpkiDerBase64, 'base64'), format: 'der', type: 'spki',
  });
}

function verifySigned(authority, signature, message) {
  const key = findActiveKey(authority, signature.keyReference);
  return Boolean(key && signature.algorithm === 'ed25519-v1' && crypto.verify(
    null, canonicalBytes(message), key, Buffer.from(signature.value, 'base64url'),
  ));
}

function verifyExchange({ request, authority }) {
  const signingMessage = { domainLabel: EXCHANGE_DOMAIN, request: withoutSignature(request) };
  const signingBytes = canonicalBytes(signingMessage);
  const requestSignatureValid = verifySigned(authority, request.signature, signingMessage);
  let parentHash = null;
  const delegationSignaturesValid = request.delegation.hops.every((hop) => {
    if (hop.parentDelegationHash !== parentHash) return false;
    const valid = verifySigned(authority, hop.signature, {
      domainLabel: DELEGATION_DOMAIN, delegation: withoutSignature(hop),
    });
    parentHash = hash(hop);
    return valid;
  });
  const replayDigest = hash({
    domainLabel: REPLAY_DOMAIN, receiverAuthorityId: authority.authorityId, request,
  });
  return {
    valid: requestSignatureValid && delegationSignaturesValid,
    requestSignatureValid,
    delegationSignaturesValid,
    canonicalSigningBytesBase64: signingBytes.toString('base64'),
    canonicalSigningSha256: crypto.createHash('sha256').update(signingBytes).digest('hex'),
    replayDigest,
  };
}

if (require.main === module) {
  try {
    const result = verifyExchange(JSON.parse(fs.readFileSync(process.argv[2] || 0, 'utf8')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({ canonicalBytes, hash, verifyExchange });
