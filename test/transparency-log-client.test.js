'use strict';

// #3608: real transparency-log client. Shape verification is not inclusion
// proof verification; this client fails closed when no proof is returned.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { verifyInclusionProof, verifyTransparencyEntry } = require('../lib/receipt/transparency-log-client');

function proofFor(leafHash, siblings = ['sibling-a', 'sibling-b']) {
  let current = leafHash;
  for (const sibling of siblings) {
    current = crypto.createHash('sha256').update(current + sibling, 'utf8').digest('hex');
  }
  return { logIndex: 7, treeSize: 9, rootHash: current, hashes: siblings, checkpoints: [] };
}

test('a fetched inclusion proof verifies against the leaf hash', async () => {
  const leafHash = 'leaf:abc123';
  const proof = proofFor(leafHash);
  const result = await verifyTransparencyEntry(
    { log: 'tlog:example', leafIndex: 7, leafHash },
    { fetchProof: async () => proof },
  );
  assert.equal(result.ok, true);
  assert.equal(result.rootHash, proof.rootHash);
});

test('no inclusion proof returned fails closed', async () => {
  const refused = await verifyTransparencyEntry(
    { log: 'tlog:example', leafIndex: 7, leafHash: 'leaf:abc123' },
    { fetchProof: async () => null },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'inclusion_proof_missing');
});

test('a fetch failure fails closed', async () => {
  const refused = await verifyTransparencyEntry(
    { log: 'tlog:example', leafIndex: 7, leafHash: 'leaf:abc123' },
    { fetchProof: async () => { throw new Error('down'); } },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'transparency_fetch_failed');
});

test('a proof with a wrong root is refused', () => {
  const result = verifyInclusionProof('leaf:abc123', { ...proofFor('leaf:other'), hashes: ['sibling-a'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inclusion_proof_mismatch');
});

test('an empty audit path is not a proof', () => {
  const result = verifyInclusionProof('leaf:abc123', { rootHash: 'deadbeef', hashes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inclusion_proof_missing');
});
