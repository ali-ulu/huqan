'use strict';

// Input parsing for the huqan-gate-hook CLI entry point (#2248).
//
// Single responsibility: read the operator's arguments, files and stdin with
// the entry point's exact limits and failure shapes. No command dispatch, no
// adapter/receipt orchestration, no exit-code decisions -- those stay in
// bin/huqan-gate-hook.js. This module is never a second authority for what a
// command does with the input.

const fs = require('node:fs');

const MAX_STDIN_BYTES = 1024 * 1024;

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function readJsonFile(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * The collector's own key for a `--store` run, or nothing. Named but unreadable
 * throws: an operator who asked for seals and silently got none would read the
 * resulting store as sealed (#1882).
 */
function readSealKeyArgument() {
  const keyPath = argumentValue('--seal-key');
  const keyReference = argumentValue('--seal-key-id');
  if (!keyPath && !keyReference) return null;
  if (!keyPath || !keyReference) throw new Error('--seal-key and --seal-key-id must be given together');
  return { keyReference, privateKeyPem: fs.readFileSync(keyPath, 'utf8') };
}

// One or more PEM public keys, separated by the END line. Used to verify the
// capability card signature; key distribution stays a deployment decision.
function readTrustedIdentityKeys(target) {
  return fs.readFileSync(target, 'utf8')
    .split('-----END PUBLIC KEY-----')
    .map((chunk) => `${chunk}-----END PUBLIC KEY-----`.trim())
    .filter((pem) => pem.startsWith('-----BEGIN PUBLIC KEY-----'));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new Error('hook input exceeds 1 MiB'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

module.exports = {
  MAX_STDIN_BYTES,
  argumentValue,
  readJsonFile,
  readSealKeyArgument,
  readTrustedIdentityKeys,
  readStdin,
};
