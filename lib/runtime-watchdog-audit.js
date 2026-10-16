'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const AUDIT_VERSION = 'huqan-watchdog-audit-v1';
const GENESIS_HASH = '0'.repeat(64);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventHash(event) {
  return crypto.createHash('sha256').update(stableJson(event)).digest('hex');
}

function readAndVerifyAudit(auditPath, fileSystem = fs) {
  if (!fileSystem.existsSync(auditPath)) return { lastHash: GENESIS_HASH, count: 0 };
  const lines = fileSystem.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch (cause) {
      const error = new Error(`Watchdog audit line ${index + 1} is not valid JSON.`);
      error.code = 'WATCHDOG_AUDIT_CORRUPT';
      error.cause = cause;
      throw error;
    }
    const { hash, ...unsigned } = record;
    if (record.version !== AUDIT_VERSION || record.previousHash !== previousHash || hash !== eventHash(unsigned)) {
      const error = new Error(`Watchdog audit chain verification failed at line ${index + 1}.`);
      error.code = 'WATCHDOG_AUDIT_CORRUPT';
      throw error;
    }
    previousHash = hash;
  }
  return { lastHash: previousHash, count: lines.length };
}

function createAuditJournal({ auditPath, fileSystem = fs, now = () => new Date() }) {
  if (!path.isAbsolute(auditPath || '')) {
    const error = new TypeError('HUQAN watchdog audit path must be absolute and outside the source tree.');
    error.code = 'WATCHDOG_AUDIT_PATH_INVALID';
    throw error;
  }
  fileSystem.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  let { lastHash, count } = readAndVerifyAudit(auditPath, fileSystem);

  function append(type, details = {}) {
    const unsigned = {
      version: AUDIT_VERSION,
      sequence: count + 1,
      timestamp: now().toISOString(),
      type,
      details,
      previousHash: lastHash,
    };
    const record = { ...unsigned, hash: eventHash(unsigned) };
    fileSystem.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    lastHash = record.hash;
    count += 1;
    return record;
  }

  return Object.freeze({ append, inspect: () => ({ auditPath, lastHash, count }) });
}

module.exports = {
  AUDIT_VERSION,
  GENESIS_HASH,
  createAuditJournal,
  readAndVerifyAudit,
};
