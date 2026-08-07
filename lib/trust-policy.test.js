const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  DEFAULT_POLICY_PATH,
  getAllowedPolicyRoots,
  loadTrustPolicy,
  getTrustPolicyVersion,
  getDefaultConfidence,
  applyTrustPolicyToProvenance,
} = require('./trust-policy');

test('loadTrustPolicy loads the default policy file', () => {
  const policy = loadTrustPolicy();
  assert.strictEqual(policy.version, '0.8.0');
  assert.strictEqual(getTrustPolicyVersion(policy), '0.8.0');
});

test('getDefaultConfidence uses subtype and fallback values', () => {
  const policy = loadTrustPolicy();
  assert.strictEqual(getDefaultConfidence('document', '', policy), 0.8);
  assert.strictEqual(getDefaultConfidence('github', 'release_tag', policy), 0.9);
  assert.strictEqual(getDefaultConfidence('unknown-type', '', policy), 0.5);
});

test('applyTrustPolicyToProvenance keeps explicit confidence and fills trustPolicyVersion', () => {
  const policy = loadTrustPolicy();
  const original = {
    sourceType: 'document',
    sourceRef: 'docs/adr.md',
    confidence: 0.77,
  };

  const { provenance, warnings } = applyTrustPolicyToProvenance(original, policy);

  assert.notStrictEqual(provenance, original);
  assert.strictEqual(provenance.confidence, 0.77);
  assert.strictEqual(provenance.trustPolicyVersion, '0.8.0');
  assert.strictEqual(warnings.length, 0);
});

test('applyTrustPolicyToProvenance fills missing confidence and returns warnings', () => {
  const policy = loadTrustPolicy();

  const { provenance, warnings } = applyTrustPolicyToProvenance({
    sourceType: 'document',
    sourceSubType: 'memo',
  }, policy);

  assert.strictEqual(provenance.confidence, 0.8);
  assert.strictEqual(provenance.trustPolicyVersion, '0.8.0');
  assert.ok(warnings.some(item => item.includes('confidence auto-filled')));
});

test('loadTrustPolicy accepts custom paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-policy-'));
  try {
    const policyPath = path.join(tempDir, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
      version: '0.8.1',
      defaults: { system: 0.42 },
      fallback: { unknown: 0.11 },
    }));

    const policy = loadTrustPolicy(policyPath);
    assert.strictEqual(policy.version, '0.8.1');
    assert.strictEqual(getDefaultConfidence('system', '', policy), 0.42);
    assert.strictEqual(getDefaultConfidence('missing', '', policy), 0.11);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadTrustPolicy rejects paths outside the allowed roots (#383)', () => {
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.axiom-policy-outside-'));
  try {
    const outsidePath = path.join(outsideDir, 'policy.json');
    fs.writeFileSync(outsidePath, JSON.stringify({ version: '9.9.9' }));

    assert.throws(
      () => loadTrustPolicy(outsidePath),
      err => err.code === 'TRUST_POLICY_PATH_NOT_ALLOWED',
    );
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('loadTrustPolicy rejects symlink targets outside the allowed roots (#383)', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-policy-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.axiom-policy-link-outside-'));
  try {
    const outsidePath = path.join(outsideDir, 'policy.json');
    const linkPath = path.join(tempDir, 'policy.json');
    fs.writeFileSync(outsidePath, JSON.stringify({ version: '9.9.9' }));
    try {
      fs.symlinkSync(outsidePath, linkPath, 'file');
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
        t.skip(`symlink creation unavailable: ${err.code}`);
        return;
      }
      throw err;
    }

    assert.throws(
      () => loadTrustPolicy(linkPath),
      err => err.code === 'TRUST_POLICY_PATH_NOT_ALLOWED',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('loadTrustPolicy rejects classic traversal payloads (#383)', () => {
  const traversal = path.join(__dirname, '..', '..', '..', '..', 'etc', 'passwd');
  assert.throws(
    () => loadTrustPolicy(traversal),
    err => err.code === 'TRUST_POLICY_PATH_NOT_ALLOWED',
  );
});

test('loadTrustPolicy throws a typed error on corrupted JSON instead of crashing (#383)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-policy-corrupt-'));
  try {
    const policyPath = path.join(tempDir, 'policy.json');
    fs.writeFileSync(policyPath, '{ not valid json');

    assert.throws(
      () => loadTrustPolicy(policyPath),
      err => err.code === 'TRUST_POLICY_INVALID_JSON',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadTrustPolicy rejects non-object policy documents (#383)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-policy-shape-'));
  try {
    const policyPath = path.join(tempDir, 'policy.json');
    fs.writeFileSync(policyPath, '[1, 2, 3]');

    assert.throws(
      () => loadTrustPolicy(policyPath),
      err => err.code === 'TRUST_POLICY_INVALID_SHAPE',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('the default policy path stays inside the allowed roots (#383)', () => {
  const roots = getAllowedPolicyRoots();
  assert.ok(roots.length > 0);
  assert.ok(roots.some(root => path.resolve(DEFAULT_POLICY_PATH).startsWith(root)));
});
