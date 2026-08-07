const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPathWithinRoot } = require('./path-safety');

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
  const roots = [
    path.join(REPO_ROOT, 'config'),
    path.join(REPO_ROOT, 'data'),
    path.resolve(process.cwd(), 'config'),
    path.resolve(process.cwd(), 'data'),
    fs.realpathSync.native ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir(),
  ];
  const extra = String(process.env.AXIOM_TRUST_POLICY_ROOTS || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => path.resolve(entry));
  return [...new Set([...roots, ...extra])];
}

function assertPolicyPathAllowed(resolvedPath) {
  const roots = getAllowedPolicyRoots();
  const candidates = [resolvedPath];
  try {
    candidates.push(fs.realpathSync(resolvedPath));
  } catch (_) {
    // Missing file: the readFileSync below reports it.
  }
  const allowed = candidates.some(candidate => roots.some(root => isPathWithinRoot(root, candidate)));
  if (!allowed) {
    throw trustPolicyError(
      'TRUST_POLICY_PATH_NOT_ALLOWED',
      `Trust policy path is outside the allowed roots: ${resolvedPath}`,
      resolvedPath,
    );
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function loadTrustPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const resolvedPath = policyPath ? path.resolve(policyPath) : DEFAULT_POLICY_PATH;
  assertPolicyPathAllowed(resolvedPath);

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

  if (!Object.prototype.hasOwnProperty.call(next, 'confidence') || typeof next.confidence !== 'number') {
    next.confidence = getDefaultConfidence(sourceType, sourceSubType, policy);
    warnings.push(`confidence auto-filled from trust policy for ${sourceType}${sourceSubType ? `/${sourceSubType}` : ''}`);
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
