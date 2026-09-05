'use strict';

/**
 * Read the collector's own signing key from deployment configuration (#1882).
 *
 * Separate from the collector itself so `server.js` stays wiring: the store
 * takes a key, it does not go looking for one. Separate from the *sender's*
 * signing key on purpose, too -- the whole value of a counter-seal is that the
 * two keys are not the same key, and sharing one variable between them would
 * make that mistake easy to make and invisible afterwards.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

function readCollectorSealKey(environment = process.env) {
  const keyPath = String(readCompatibleEnvironmentVariable('COLLECTOR_SEAL_KEY', environment) || '').trim();
  const keyReference = String(readCompatibleEnvironmentVariable('COLLECTOR_SEAL_KEY_ID', environment) || '').trim();
  if (!keyPath && !keyReference) return null;
  // Half a configuration is a mistake worth failing on: a collector that
  // silently stops sealing looks, to every later reader, exactly like a
  // collector that was never asked to.
  if (!keyPath) throw new Error('collector seal key id was set without HUQAN_COLLECTOR_SEAL_KEY');
  if (!keyReference) throw new Error('collector seal key was set without HUQAN_COLLECTOR_SEAL_KEY_ID');
  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
  } catch (_) {
    throw new Error(`collector seal key is unreadable: ${keyPath}`);
  }
  return { keyReference, privateKeyPem };
}

module.exports = { readCollectorSealKey };
