const fs = require('fs');
const path = require('path');
const { isPathWithinRoot } = require('./path-safety');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { verifySealedPolicy } = require('./receipt/policy-seal');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'trust-policy.default.json');

function trustPolicyError(code, message, policyPath) {
  const err = new Error(message);
  err.code = code;
  if (policyPath) err.path = policyPath;
  return err;
}

// Trust policies may only be read from directories that the operator controls.
// Without this, a caller-supplied path turns loadTrustPolicy() into an
// arbitrary-file read primitive (e.g. ../../../etc/passwd).
function getAllowedPolicyRoots() {
  // #1297: os.tmpdir() used to be a base root here. On a multi-user system
  // that directory is world-writable shared storage (sticky /tmp), not
  // something "the operator controls" -- another local user could plant a
  // trust-policy JSON there and have loadTrustPolicy() load it if any caller
  // ever resolves a path into tmpdir. A test-only need for a scratch root
  // belongs behind TRUST_POLICY_ROOTS below, pointed at a directory the test
  // itself creates and controls -- not granted to every caller by default.
  const roots = [
    path.join(REPO_ROOT, 'config'),
    path.join(REPO_ROOT, 'data'),
    path.resolve(process.cwd(), 'config'),
    path.resolve(process.cwd(), 'data'),
  ];
  const extra = String(readCompatibleEnvironmentVariable('TRUST_POLICY_ROOTS') || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
  const resolved = [...new Set([...roots, ...extra])];
  // Accept each root's real path too, so a realpath'd candidate under a
  // symlinked root (macOS /var -> /private/var, #2549) is still inside it.
  // Same convention as getCliReadRoots in lib/cli-helpers.js. This only
  // widens the spelling of already-granted roots; a candidate that
  // canonicalizes outside every granted root is still rejected below.
  const real = resolved.map((entry) => {
    try { return fs.realpathSync(entry); } catch (_) { return entry; }
  });
  return [...new Set([...resolved, ...real])];
}

function assertPolicyPathAllowed(resolvedPath) {
  const roots = getAllowedPolicyRoots();
  const candidates = [resolvedPath];
  try {
    candidates.push(fs.realpathSync(resolvedPath));
  } catch (_) {
    // Missing file: the readFileSync below reports it.
  }
  const allowed = candidates.every(candidate => roots.some(root => isPathWithinRoot(root, candidate)));
  if (!allowed) {
    throw trustPolicyError(
      'TRUST_POLICY_PATH_NOT_ALLOWED',
      `Trust policy path is outside the allowed roots: ${resolvedPath}`,
      resolvedPath,
    );
  }
}

const { cloneJson: clone } = require('./json-clone');

// #4582 (R35 follow-up): a deployment that configures a public key makes a
// valid seal mandatory. The requirement is read from the environment, never
// from the policy file: a policy that could declare `signatureRequired: false`
// could be unsigned by the same actor who rewrote it, which is the exact
// threat the seal exists to stop. Absent the variable, loading is unchanged.
function readTrustPolicyPublicKey() {
  const keyPath = String(readCompatibleEnvironmentVariable('TRUST_POLICY_PUBLIC_KEY') || '').trim();
  if (!keyPath) return '';
  try {
    return fs.readFileSync(path.resolve(keyPath), 'utf8');
  } catch (cause) {
    const error = new Error('trust policy signature configuration is invalid');
    error.code = 'TRUST_POLICY_CONFIG_INVALID';
    error.cause = cause;
    throw error;
  }
}

function assertPolicySeal(parsed, resolvedPath, publicKeyPem) {
  const sealed = parsed && parsed.seal;
  const subject = {
    kind: 'policy',
    knowledgeId: parsed ? parsed.knowledgeId : undefined,
    version: parsed ? parsed.version : undefined,
    workspaceId: parsed ? parsed.workspaceId : undefined,
    content: parsed ? parsed.content : undefined,
  };
  const allowMissingTransparency = readCompatibleEnvironmentVariable('TRUST_POLICY_ALLOW_MISSING_TRANSPARENCY') === 'true';
  const result = verifySealedPolicy(sealed, subject, { publicKeyPem, allowMissingTransparency });
  if (!result || result.ok !== true) {
    const reason = (result && result.reason) || 'malformed_sealed_policy';
    throw trustPolicyError(
      sealed ? 'TRUST_POLICY_SEAL_INVALID' : 'TRUST_POLICY_SIGNATURE_REQUIRED',
      `Trust policy seal is not valid (${reason}): ${resolvedPath}`,
      resolvedPath,
    );
  }
}

function loadTrustPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const resolvedPath = policyPath ? path.resolve(policyPath) : DEFAULT_POLICY_PATH;
  assertPolicyPathAllowed(resolvedPath);
  const publicKeyPem = readTrustPolicyPublicKey();

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw trustPolicyError(
      'TRUST_POLICY_INVALID_JSON',
      `Trust policy file is not valid JSON: ${resolvedPath} (${e.message})`,
      resolvedPath,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw trustPolicyError(
      'TRUST_POLICY_INVALID_SHAPE',
      `Trust policy file must contain a JSON object: ${resolvedPath}`,
      resolvedPath,
    );
  }
  // A seal is required when the deployment configures a public key -- the
  // authority a policy-file rewrite cannot switch off -- or when the file
  // itself declares one. A present seal is always verified rather than
  // silently dropped, so shipping a sealed policy cannot quietly degrade to an
  // unsigned one. A signed envelope is
  // {kind, knowledgeId, version, workspaceId, content, seal}: the seal is
  // verified first and `content` (the weights the rest of the loader reads) is
  // unwrapped only after it holds.
  const sealPresent = Boolean(parsed.seal) && typeof parsed.seal === 'object';
  if (publicKeyPem || parsed.signatureRequired === true || sealPresent) {
    if (!publicKeyPem) {
      throw trustPolicyError(
        'TRUST_POLICY_CONFIG_INVALID',
        `Trust policy requires a seal but no public key is configured: ${resolvedPath}`,
        resolvedPath,
      );
    }
    assertPolicySeal(parsed, resolvedPath, publicKeyPem);
    return clone(parsed.content);
  }
  return clone(parsed);
}

function getTrustPolicyVersion(policy) {
  return String(policy && policy.version ? policy.version : '0.8.0');
}

function getDefaultConfidence(sourceType, sourceSubType, policy) {
  const normalizedType = String(sourceType || '').trim().toLowerCase();
  const normalizedSubType = String(sourceSubType || '').trim().toLowerCase();
  const defaults = policy && policy.defaults ? policy.defaults : {};
  const fallback = policy && policy.fallback ? policy.fallback : {};

  if (
    normalizedType &&
    policy &&
    policy[normalizedType] &&
    normalizedSubType &&
    typeof policy[normalizedType][normalizedSubType] === 'number'
  ) {
    return policy[normalizedType][normalizedSubType];
  }

  if (normalizedType && typeof defaults[normalizedType] === 'number') {
    return defaults[normalizedType];
  }

  return typeof fallback.unknown === 'number' ? fallback.unknown : 0.5;
}

function applyTrustPolicyToProvenance(provenance, policy, opts = {}) {
  const next = clone(provenance) || {};
  const warnings = [];
  const sourceType = String(next.sourceType || opts.sourceType || 'system').trim().toLowerCase() || 'system';
  const sourceSubType = String(next.sourceSubType || opts.sourceSubType || '').trim().toLowerCase();

  const policyConfidence = getDefaultConfidence(sourceType, sourceSubType, policy);

  // The policy score is authoritative. An author-supplied confidence is never
  // allowed to replace it: at most it is combined with it as a cap (min), so a
  // low-trust source cannot be promoted to 'allow' by asserting confidence: 1.
  // (#4245, CWE-807)
  if (Object.prototype.hasOwnProperty.call(next, 'confidence') && typeof next.confidence === 'number' && Number.isFinite(next.confidence)) {
    const claimed = next.confidence;
    if (claimed > policyConfidence) {
      next.confidence = policyConfidence;
      next.confidenceSource = 'explicit_capped_by_policy';
      warnings.push(`confidence capped to trust-policy score ${policyConfidence} (claimed ${claimed})`);
    } else {
      next.confidenceSource = 'explicit';
    }
  } else {
    next.confidence = policyConfidence;
    const defaults = policy && policy.defaults ? policy.defaults : {};
    const label = `${sourceType}${sourceSubType ? `/${sourceSubType}` : ''}`;
    if (sourceSubType && policy && policy[sourceType]
        && typeof policy[sourceType][sourceSubType] === 'number') {
      next.confidenceSource = 'policy_subtable';
      warnings.push(`confidence auto-filled from trust policy sub-table for ${label}`);
    } else if (typeof defaults[sourceType] === 'number') {
      next.confidenceSource = 'policy_default';
      warnings.push(`confidence auto-filled from trust policy default for ${sourceType}`);
    } else {
      next.confidenceSource = 'unknown_fallback';
      warnings.push(
        `confidence auto-filled from the unknown fallback: trust policy has no entry `
        + `for ${label}`,
      );
    }
  }

  next.sourceType = sourceType;
  if (sourceSubType) next.sourceSubType = sourceSubType;
  else delete next.sourceSubType;
  next.trustPolicyVersion = getTrustPolicyVersion(policy);

  return { provenance: next, warnings };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  getAllowedPolicyRoots,
  loadTrustPolicy,
  getTrustPolicyVersion,
  getDefaultConfidence,
  applyTrustPolicyToProvenance,
};
