'use strict';

// The approval authority's private state (#3860, ADR-016 items 1, 3, 4, 6).
//
// keys.json        the Ed25519 signing key and the X25519 sealing key
// totp-secret.json the operator's TOTP secret
// totp-progress.json the last accepted TOTP step, recent failures, lockout
//
// The directory is ACL'd to SYSTEM and the service's own SID by the installer,
// so nothing here is readable by the interactive user. Secrets are written
// once, with `wx`: re-running init cannot rotate them behind the operator's
// back. Progress is rewritten atomically (temporary file, fsync, rename), and
// a progress file that does not parse fails closed -- resetting it would
// reset the replay counter and make every recent code usable again.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { generateTotpSecret, base32Encode, base32Decode } = require('./totp');

const KEYS_FILE = 'keys.json';
const SECRET_FILE = 'totp-secret.json';
const PROGRESS_FILE = 'totp-progress.json';
const INITIAL_PROGRESS = Object.freeze({ lastCounter: -1, failures: [], lockedUntil: null });

function writeOnce(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function writeAtomically(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  // Make the rename itself durable where the platform allows a directory
  // fsync (POSIX); Windows refuses to open a directory for it and NTFS
  // journals the rename.
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* not supported here */ }
}

function assertProgress(progress) {
  const { lastCounter, failures, lockedUntil } = progress || {};
  if (!Number.isInteger(lastCounter) || lastCounter < -1) throw new TypeError('lastCounter must be an integer >= -1');
  if (!Array.isArray(failures) || !failures.every(Number.isFinite)) throw new TypeError('failures must be a list of instants');
  if (lockedUntil !== null && !Number.isFinite(lockedUntil)) throw new TypeError('lockedUntil must be an instant or null');
  return { lastCounter, failures: [...failures], lockedUntil };
}

function pem(key, type) {
  return key.export({ type, format: 'pem' });
}

function createAuthorityState({ dir }) {
  // 0o700 on POSIX so the state directory is closed to group and other even
  // under a permissive umask; the Windows installer ACLs it instead and ignores
  // the mode. `serve` refuses to start when a POSIX state dir is looser than
  // this (ADR-020 §7).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const signing = crypto.generateKeyPairSync('ed25519');
  const sealing = crypto.generateKeyPairSync('x25519');
  // #3940: anchors the ledger head in Rekor, which takes ECDSA P-256 but not pure Ed25519.
  const anchor = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const totpSecret = generateTotpSecret();
  writeOnce(path.join(dir, KEYS_FILE), { signingKey: pem(signing.privateKey, 'pkcs8'), sealingKey: pem(sealing.privateKey, 'pkcs8'),
    anchorKey: pem(anchor.privateKey, 'pkcs8') });
  writeOnce(path.join(dir, SECRET_FILE), { secret: base32Encode(totpSecret) });
  writeOnce(path.join(dir, PROGRESS_FILE), INITIAL_PROGRESS);
  return { totpSecret, signingPublicKeyPem: pem(signing.publicKey, 'spki'), sealingPublicKeyPem: pem(sealing.publicKey, 'spki'),
    anchorPublicKeyPem: pem(anchor.publicKey, 'spki') };
}

function openAuthorityState({ dir }) {
  const keys = JSON.parse(fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8'));
  const { secret } = JSON.parse(fs.readFileSync(path.join(dir, SECRET_FILE), 'utf8'));
  const progressFile = path.join(dir, PROGRESS_FILE);

  function readTotp() {
    try {
      return assertProgress(JSON.parse(fs.readFileSync(progressFile, 'utf8')));
    } catch (error) {
      throw new Error(`TOTP progress is unreadable; refusing to guess the replay counter (${error.message})`);
    }
  }

  function writeTotp(progress) {
    writeAtomically(progressFile, assertProgress(progress));
  }

  return {
    signingKey: crypto.createPrivateKey(keys.signingKey),
    sealingKey: crypto.createPrivateKey(keys.sealingKey),
    // Null in a state created before #3940: the anchor route then answers ANCHOR_KEY_MISSING.
    anchorKey: keys.anchorKey ? crypto.createPrivateKey(keys.anchorKey) : null,
    totpSecret: base32Decode(secret),
    readTotp,
    writeTotp,
  };
}

module.exports = { createAuthorityState, openAuthorityState };
