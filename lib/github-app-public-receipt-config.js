'use strict';

/**
 * Read the public trust receipt signing key from deployment configuration.
 *
 * Separate from ./receipt/public-trust-receipt.js for the same reason
 * ./issuer-seal-config.js is separate from ./receipt/issuer-seal.js: the
 * exporter takes a key, it does not go looking for one. This is the one place
 * that turns an operator's configuration into the Ed25519 private key the
 * exporter needs, and it returns the KeyObject the exporter requires so an
 * unusable key cannot reach a write path.
 *
 * Two variables, like ./collector-seal-config.js rather than the single
 * variable ./issuer-seal-config.js reads. The issuer seal derives its id from
 * the key, which is safe because that id never leaves the instance. A public
 * receipt key reference is different: it is the string a third party matches
 * against its trusted-key records, so it is the deployment's to name, not this
 * module's to invent. Which key that is -- a key of its own, or the issuer's --
 * is the operator's choice here; the two variables make either one expressible.
 *
 * The path is deliberately not printed on failure, matching
 * ./github-app-beta-http-config.js rather than ./issuer-seal-config.js: this is
 * an operator-facing startup error, and a key path is the kind of detail that
 * ends up in a log someone else can read. The cause is attached, not formatted
 * into the message, so a misconfiguration stays distinguishable from a bug in
 * this file without disclosing where the key lives.
 *
 * Absent both variables this returns null and nothing is published. Half a
 * configuration, an unreadable file, or a key that is not Ed25519 throws: a
 * deployment that asked to publish and silently did not looks, to every later
 * reader, exactly like one that never asked.
 *
 * The key id is returned as declared. Whether it is a reference the exporter
 * will accept is the exporter's own check -- `boundedKeyReference` refuses a
 * scheme it does not permit, and the publish path fails closed on that refusal
 * rather than signing under an id a verifier could not resolve.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV = 'GITHUB_APP_PUBLIC_RECEIPT_KEY';
const GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV = 'GITHUB_APP_PUBLIC_RECEIPT_KEY_ID';

function failConfig(cause) {
  const error = new Error('public trust receipt configuration is invalid');
  error.code = 'GITHUB_APP_PUBLIC_RECEIPT_CONFIG_INVALID';
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function readGitHubAppPublicReceiptConfig(environment = process.env) {
  const keyPath = String(readCompatibleEnvironmentVariable(GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV, environment) || '').trim();
  const keyId = String(readCompatibleEnvironmentVariable(GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV, environment) || '').trim();
  if (!keyPath && !keyId) return null;
  // Half a configuration is the mistake worth failing on: an id with no key
  // names a signer that cannot sign, and a key with no id cannot be referenced
  // by the receipt it produces.
  if (!keyPath) failConfig();
  if (!keyId) failConfig();

  let privateKeyPem;
  try {
    privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
  } catch (error) {
    failConfig(error);
  }

  // Fail at configuration time rather than on the first receipt: an Ed25519
  // private key is the only thing the exporter can sign with, and finding that
  // out on a write path means a delivery that cannot publish the receipt it
  // promised.
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (error) {
    failConfig(error);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') failConfig();

  return Object.freeze({ keyId, privateKey });
}

module.exports = {
  GITHUB_APP_PUBLIC_RECEIPT_KEY_ENV,
  GITHUB_APP_PUBLIC_RECEIPT_KEY_ID_ENV,
  readGitHubAppPublicReceiptConfig,
};
