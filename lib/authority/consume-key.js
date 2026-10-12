'use strict';

// The runtime's local key for consume proofs (#3860, ADR-016). A key that
// exists is reused, never replaced, so proofs for approvals already registered
// stay valid. A new key is written to a temporary file and linked into place,
// so a reader never sees half a key and two first runs agree on one key: the
// loser of the race reads the winner's. Owner-only mode is applied where the
// platform honours it. See lib/authority/registration-payload.js for what the
// proof does and does not protect.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_BYTES = 32;

function defaultConsumeKeyPath() {
  return path.join(os.homedir(), '.huqan', 'authority-consume.key');
}

function readKey(file) {
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== KEY_BYTES) throw new Error(`consume key at ${file} is not ${KEY_BYTES} bytes of hex`);
  return key;
}

function loadOrCreateConsumeKey(file = defaultConsumeKeyPath()) {
  try {
    return readKey(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${crypto.randomBytes(KEY_BYTES).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return readKey(file);
}

module.exports = { defaultConsumeKeyPath, loadOrCreateConsumeKey };
