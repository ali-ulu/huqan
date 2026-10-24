'use strict';

// #3608: real transparency-log client. Shape verification is not inclusion
// proof verification; this client fails closed when no proof is returned.
//
// #4220: an inclusion proof is only meaningful relative to a root the log
// signed. The proof carries both the audit path and the root, so verifying the
// path against the proof's own root proves nothing -- an attacker can mint a
// leaf, an audit path and a matching root and it will "verify". Every check
// below therefore anchors the proof to a signed checkpoint.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  verifyInclusionProof,
  verifyTransparencyCheckpoint,
  verifyTransparencyEntry,
} = require('../lib/receipt/transparency-log-client');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const otherPublicKeyPem = crypto.generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' });

const LOG = 'tlog:example';

function rootOf(leafHash, siblings) {
  let current = leafHash;
  for (const sibling of siblings) {
    current = crypto.createHash('sha256').update(current + sibling, 'utf8').digest('hex');
  }
  return current;
}

function checkpointFor({ log = LOG, treeSize = 9, rootHash }) {
  const statement = { log, treeSize, rootHash };
  const signature = crypto.sign(
    null,
    Buffer.from(JSON.stringify(statement), 'utf8'),
    privateKey,
  ).toString('base64');
  return { ...statement, signature };
}

function proofFor(leafHash, siblings = ['sibling-a', 'sibling-b'], extra = {}) {
  return { logIndex: 7, treeSize: 9, rootHash: rootOf(leafHash, siblings), hashes: siblings, checkpoints: [], ...extra };
}

test('a fetched inclusion proof verifies against the leaf hash and a signed checkpoint', async () => {
  const leafHash = 'leaf:abc123';
  const siblings = ['sibling-a', 'sibling-b'];
  const proof = proofFor(leafHash, siblings);
  const checkpoint = checkpointFor({ rootHash: proof.rootHash });

  const result = await verifyTransparencyEntry(
    { log: LOG, leafIndex: 7, leafHash },
    { fetchProof: async () => proof, checkpoint, logPublicKeyPem: publicKeyPem },
  );
  assert.equal(result.ok, true);
  assert.equal(result.rootHash, proof.rootHash);
});

test('a forged proof with no checkpoint is refused (#4220)', () => {
  // The attacker mints leaf + audit path + root together; with no signed
  // checkpoint there is nothing to anchor the root to.
  const leafHash = 'leaf:forged';
  const proof = proofFor(leafHash);
  const result = verifyInclusionProof(leafHash, proof);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'checkpoint_missing');
});

test('a proof whose root disagrees with the signed checkpoint is refused (#4220)', () => {
  const leafHash = 'leaf:abc123';
  const proof = proofFor(leafHash);
  // A checkpoint signed by the real log for a *different* tree.
  const checkpoint = checkpointFor({ rootHash: rootOf('leaf:something-else', ['x', 'y']) });
  const result = verifyInclusionProof(leafHash, proof, { checkpoint, log: LOG, logPublicKeyPem: publicKeyPem });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inclusion_root_not_checkpointed');
});

test('a checkpoint signed by the wrong key is refused (#4220)', () => {
  const leafHash = 'leaf:abc123';
  const proof = proofFor(leafHash);
  const checkpoint = checkpointFor({ rootHash: proof.rootHash });
  const result = verifyInclusionProof(leafHash, proof, { checkpoint, log: LOG, logPublicKeyPem: otherPublicKeyPem });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'checkpoint_signature_invalid');
});

test('an unsigned or malformed checkpoint is refused (#4220)', () => {
  const leafHash = 'leaf:abc123';
  const proof = proofFor(leafHash);
  const rootHash = proof.rootHash;
  const cases = [
    [null, 'checkpoint_missing'],
    [{ treeSize: 9, rootHash }, 'checkpoint_unsigned'],
    [{ log: LOG, treeSize: 9, rootHash, signature: 'not-base64!!' }, 'checkpoint_signature_invalid'],
    [{ treeSize: -1, rootHash, signature: 'AAAA' }, 'checkpoint_malformed'],
  ];
  for (const [checkpoint, reason] of cases) {
    const result = verifyInclusionProof(leafHash, proof, { checkpoint, log: LOG, logPublicKeyPem: publicKeyPem });
    assert.equal(result.ok, false, JSON.stringify(checkpoint));
    assert.equal(result.reason, reason);
  }
});

test('the checkpoint verifier is fail-closed on a missing key (#4220)', () => {
  const checkpoint = checkpointFor({ rootHash: rootOf('leaf:abc123', ['s']) });
  assert.equal(verifyTransparencyCheckpoint(checkpoint, { log: LOG }).reason, 'checkpoint_key_missing');
  assert.equal(verifyTransparencyCheckpoint(checkpoint, { log: 'tlog:other', logPublicKeyPem: publicKeyPem }).reason,
    'checkpoint_log_mismatch');
  assert.equal(verifyTransparencyCheckpoint(checkpoint, { log: LOG, logPublicKeyPem: publicKeyPem }).ok, true);
});

test('the checkpoint must name the expected log; neither side may leave it out (#4220)', () => {
  const checkpoint = checkpointFor({ rootHash: rootOf('leaf:abc123', ['s']) });
  assert.equal(verifyTransparencyCheckpoint(checkpoint, { logPublicKeyPem: publicKeyPem }).reason, 'checkpoint_log_missing');
  const { log: _omitted, ...unnamed } = checkpoint;
  assert.equal(verifyTransparencyCheckpoint(unnamed, { log: LOG, logPublicKeyPem: publicKeyPem }).reason, 'checkpoint_log_mismatch');
  const proof = proofFor('leaf:abc123', ['s']);
  const verified = verifyInclusionProof('leaf:abc123', proof, { checkpoint, log: LOG, logPublicKeyPem: publicKeyPem });
  assert.equal(verified.ok, true);
  assert.equal('logIndex' in verified, false, 'the proof\'s logIndex is not covered by the checkpoint, so it is not reported');
});

test('no inclusion proof returned fails closed', async () => {
  const checkpoint = checkpointFor({ rootHash: rootOf('leaf:abc123', ['s']) });
  const refused = await verifyTransparencyEntry(
    { log: LOG, leafIndex: 7, leafHash: 'leaf:abc123' },
    { fetchProof: async () => null, checkpoint, logPublicKeyPem: publicKeyPem },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'inclusion_proof_missing');
});

test('a missing checkpoint fails closed before the proof is trusted', async () => {
  const refused = await verifyTransparencyEntry(
    { log: LOG, leafIndex: 7, leafHash: 'leaf:abc123' },
    { fetchProof: async () => proofFor('leaf:abc123') },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'checkpoint_missing');
});

test('a fetch failure fails closed', async () => {
  const checkpoint = checkpointFor({ rootHash: rootOf('leaf:abc123', ['s']) });
  const refused = await verifyTransparencyEntry(
    { log: LOG, leafIndex: 7, leafHash: 'leaf:abc123' },
    { fetchProof: async () => { throw new Error('down'); }, checkpoint, logPublicKeyPem: publicKeyPem },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'transparency_fetch_failed');
});

test('a proof with a wrong root is refused', () => {
  const leafHash = 'leaf:abc123';
  const siblings = ['sibling-a'];
  // Checkpoint signs the root for a different leaf's path, so the root itself
  // is checkpointed but the recomputed path for our leaf disagrees with it.
  const checkpointRoot = rootOf('leaf:other', siblings);
  const checkpoint = checkpointFor({ rootHash: checkpointRoot });
  const proof = { logIndex: 7, treeSize: 9, rootHash: checkpointRoot, hashes: siblings };
  const result = verifyInclusionProof(leafHash, proof,
    { checkpoint, log: LOG, logPublicKeyPem: publicKeyPem });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inclusion_proof_mismatch');
});

test('an empty audit path is not a proof', () => {
  const result = verifyInclusionProof('leaf:abc123', { rootHash: 'deadbeef', hashes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inclusion_proof_missing');
});
