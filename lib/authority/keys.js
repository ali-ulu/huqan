'use strict';

// Key normalization for the approval authority (#3860). Keys arrive as PEM
// from the state and pin files and as KeyObjects in-process; either way the
// algorithm is checked, so a wrong key in a pin file fails closed instead of
// silently verifying under another algorithm.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');

function typed(key, type) {
  if (key.asymmetricKeyType !== type) throw new TypeError(`expected an ${type} key, got ${key.asymmetricKeyType}`);
  return key;
}

function publicKeyOf(key, type) {
  if (key instanceof crypto.KeyObject) return typed(key.type === 'public' ? key : crypto.createPublicKey(key), type);
  return typed(crypto.createPublicKey(key), type);
}

function privateKeyOf(key, type) {
  const privateKey = key instanceof crypto.KeyObject ? key : crypto.createPrivateKey(key);
  if (privateKey.type !== 'private') throw new TypeError(`expected an ${type} private key`);
  return typed(privateKey, type);
}

module.exports = { publicKeyOf, privateKeyOf };
