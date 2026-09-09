'use strict';

/**
 * Read the issuing instance's signing key from deployment configuration.
 *
 * Separate from ./receipt/issuer-seal.js so the primitive stays a pure
 * builder: the seal takes a key, it does not go looking for one. Separate
 * from ./collector-seal-config.js on purpose too -- the issuer signs what it
 * produced and the collector signs what it received, and the whole value of a
 * counter-seal is that those are not the same key. Sharing one variable
 * between them would make that mistake easy to make and invisible afterwards.
 *
 * Only one variable, unlike the collector's pair: the key id does not need
 * configuring because it is *derived* from the key itself. That removes the
 * half-configured failure mode rather than having to guard against it -- a
 * declared id that disagrees with the key is not a state this can reach.
 *
 * Absent the variable this returns null and nothing is sealed. Present but
 * unreadable throws: a deployment that asked for sealing and silently did not
 * seal looks, to every later reader, exactly like one that never asked.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { issuerKeyFingerprint } = require('./receipt/issuer-seal');

function readIssuerSealKey(environment = process.env) {
  const keyPath = String(readCompatibleEnvironmentVariable('ISSUER_SEAL_KEY', environment) || '').trim();
  if (!keyPath) return null;

  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
  } catch (_) {
    throw new Error(`issuer seal key is unreadable: ${keyPath}`);
  }

  // Fail at configuration time rather than on the first receipt: an ed25519
  // key is the only thing the seal can be made with, and finding that out on
  // a write path means a mutation that cannot produce the receipt it promised.
  const crypto = require('node:crypto');
  let keyId = '';
  try {
    const key = crypto.createPrivateKey(privateKeyPem);
    keyId = issuerKeyFingerprint(crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString());
  } catch (_) {
    keyId = '';
  }
  if (!keyId) throw new Error(`issuer seal key is not a usable ed25519 private key: ${keyPath}`);

  return { keyId, privateKeyPem };
}

module.exports = { readIssuerSealKey };
