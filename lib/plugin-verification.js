const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { createActivationGate } = require('./supply-chain-activation-gate');

// Where a loaded plugin's verification record is kept. Non-enumerable, and
// shared by plugin.js and the lib/plugin-manager-* method modules.
const VERIFIED_PLUGIN = Symbol('axiom.verifiedPlugin');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hmacSign(value, signingKey) {
  return crypto.createHmac('sha256', String(signingKey)).update(String(value)).digest('hex');
}

function getManifestPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function readManifest(filePath) {
  const manifestPath = getManifestPath(filePath);
  if (!fs.existsSync(manifestPath)) return null;
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function loadActivationGate() {
  const raw = readCompatibleEnvironmentVariable('SUPPLY_CHAIN_ACTIVATION_POLICY');
  if (!raw) return null;
  try { return createActivationGate(JSON.parse(raw)); } catch (error) {
    const wrapped = new Error(`Invalid supply-chain activation policy: ${error.message}`);
    wrapped.code = 'SUPPLY_CHAIN_ACTIVATION_POLICY_INVALID';
    throw wrapped;
  }
}

/**
 * Verifies that a plugin file is the one the operator approved.
 *
 * #362: read the status names literally. 'verified' means the file matches its
 * adjacent manifest hash; 'verified-signed' means that hash is HMAC-signed with
 * the deployment key. Neither says anything about what the plugin *does* --
 * there is no sandbox, and load() below hands the file straight to require(),
 * so a perfectly signed plugin still runs in-process with full host privileges.
 * Signing answers "is this the code we approved?", not "is this code allowed to
 * do that?".
 *
 * That gap is documented on purpose -- docs/core-plugin-boundary-contract.md
 * ("Enforcement Boundary: Signed Is Not Sandboxed") and THREAT_MODEL.md
 * ("Plugin Code Execution"). Do not close it by wrapping require() in vm: the
 * vm module is not a security boundary, so that would advertise confinement the
 * runtime cannot deliver.
 */
function verifyPluginFile(filePath, opts = {}) {
  const strict = opts.strict === true;
  const productionEnforcement = opts.productionEnforcement === true;
  const signatureKey = opts.signatureKey || readCompatibleEnvironmentVariable('PLUGIN_SIGNING_KEY') || '';
  const currentHash = hashFile(filePath);

  // #391: hash-only verification proves a plugin file matches its adjacent
  // manifest.json -- nothing more. An attacker with filesystem write access
  // can rewrite both together, so once production enforcement is active, a
  // missing signing key must not silently fall back to that weaker
  // guarantee. This is narrower than plain `strict` (which defaults on
  // everywhere HUQAN_PLUGIN_STRICT isn't explicitly '0', including normal
  // dev/test runs loading unsigned first-party plugins) -- only actual
  // production enforcement requires a signing key to load anything at all.
  if (productionEnforcement && !signatureKey) {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath: getManifestPath(filePath),
      reason: 'Plugin signing key is required under production enforcement.',
    };
  }

  const manifestRecord = readManifest(filePath);

  if (!manifestRecord) {
    return {
      ok: !strict,
      status: strict ? 'rejected' : 'unverified',
      sha256: currentHash,
      manifestPath: getManifestPath(filePath),
      reason: strict ? 'Plugin manifest is required in strict mode.' : 'Plugin manifest not found.',
    };
  }

  const { manifest, manifestPath } = manifestRecord;
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath,
      reason: 'Plugin manifest is invalid.',
    };
  }

  if (manifest.sha256 !== currentHash) {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath,
      reason: 'Plugin hash mismatch.',
    };
  }

  if (signatureKey) {
    if (!manifest.signature) {
      return {
        ok: !strict,
        status: strict ? 'rejected' : 'hash-only',
        sha256: currentHash,
        manifestPath,
        reason: strict ? 'Plugin signature is required in strict mode.' : 'Plugin signature not found.',
      };
    }
    const expectedSignature = hmacSign(currentHash, signatureKey);
    if (manifest.signature !== expectedSignature) {
      return {
        ok: false,
        status: 'rejected',
        sha256: currentHash,
        manifestPath,
        reason: 'Plugin signature mismatch.',
      };
    }
  }

  return {
    ok: true,
    status: signatureKey ? 'verified-signed' : 'verified',
    sha256: currentHash,
    manifestPath,
    manifest,
    filePath,
    reason: signatureKey ? 'Plugin hash and signature verified.' : 'Plugin hash verified.',
  };
}

function isRuntimePluginFile(fileName) {
  return (
    fileName.endsWith('.js') &&
    !fileName.endsWith('.test.js') &&
    !fileName.endsWith('.spec.js')
  );
}

module.exports = {
  VERIFIED_PLUGIN,
  hashFile,
  hmacSign,
  getManifestPath,
  readManifest,
  loadActivationGate,
  verifyPluginFile,
  isRuntimePluginFile,
};
