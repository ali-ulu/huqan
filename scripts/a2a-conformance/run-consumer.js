'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { encodeJsonStableV1 } = require('../../lib/receipt/cryptographic-profile-contract');
const { canonicalHash, signingView } = require('./verifier');

const { CONSUMER, CLEAN_ROOM_RECEIVER, clone } = require('./run-support');
const { buildFixture } = require('./run-fixture');

function invokeConsumer(authority, requests) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-d6-'));
  try {
    const authorityPath = path.join(temp, 'receiver-authority.json');
    fs.writeFileSync(authorityPath, JSON.stringify(authority), { encoding: 'utf8', mode: 0o600 });
    const child = spawnSync(process.execPath, [CONSUMER, temp, authorityPath], {
      input: JSON.stringify({ requests }),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || 'consumer failed');
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function spawnConsumer(replayDirectory, authorityPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONSUMER, replayDirectory, authorityPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status !== 0) return reject(new Error(stderr || 'concurrent consumer failed'));
      try { return resolve(JSON.parse(stdout)); } catch (error) { return reject(error); }
    });
    child.stdin.end(JSON.stringify({ requests: [request] }));
  });
}

function cleanRoomCases(fixture) {
  const cases = [];
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-clean-room-'));
  try {
    const exchangePath = path.join(temp, 'exchange.json');
    fs.writeFileSync(exchangePath, JSON.stringify({
      request: fixture.request, authority: fixture.authority,
    }), 'utf8');
    const child = spawnSync(process.execPath, [CLEAN_ROOM_RECEIVER, exchangePath], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    const external = JSON.parse(child.stdout);
    const producerBytes = encodeJsonStableV1(signingView(fixture.request));
    const producerHash = crypto.createHash('sha256').update(producerBytes).digest('hex');
    const producerReplayDigest = canonicalHash({
      domainLabel: 'HUQAN/V5/D6/A2A-REPLAY/v1',
      receiverAuthorityId: fixture.authority.authorityId,
      request: fixture.request,
    });
    assert.equal(external.valid, true);
    assert.equal(external.canonicalSigningBytesBase64, producerBytes.toString('base64'));
    assert.equal(external.canonicalSigningSha256, producerHash);
    assert.equal(external.replayDigest, producerReplayDigest);
    cases.push({
      caseId: 'third_party_clean_room_receiver_byte_exact_signed_exchange',
      expected: 'valid and byte-for-byte producer agreement',
      actual: 'valid and byte-for-byte producer agreement', passed: true,
    });

    const tampered = clone(fixture.request);
    // Flip the first character, the way the other two tamper cases do, not
    // the last one. A 64-byte signature is 86 base64url characters — 516
    // bits carrying 512 — so the final character's low four bits decode to
    // nothing. Rewriting it to 'A' or 'B' left the signature byte-identical
    // whenever it already began with those four bits (any of A-P), the
    // receiver rightly accepted an exchange nobody had tampered with, and
    // the case failed for having tampered with nothing. Measured before this
    // change: 7 of 16 runs red. After: 16 of 16 green, same report digest.
    const signatureValue = tampered.signature.value;
    tampered.signature.value = `${signatureValue[0] === 'A' ? 'B' : 'A'}${signatureValue.slice(1)}`;
    fs.writeFileSync(exchangePath, JSON.stringify({
      request: tampered, authority: fixture.authority,
    }), 'utf8');
    const rejected = spawnSync(process.execPath, [CLEAN_ROOM_RECEIVER, exchangePath], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).valid, false);
    cases.push({
      caseId: 'third_party_clean_room_receiver_rejects_tampered_signature',
      expected: 'cryptographic refusal', actual: 'cryptographic refusal', passed: true,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return cases;
}

async function concurrentCases() {
  const cases = [];
  const one = buildFixture();
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-d6-concurrent-'));
  try {
    const authorityPath = path.join(temp, 'receiver-authority.json');
    fs.writeFileSync(authorityPath, JSON.stringify(one.authority), { encoding: 'utf8', mode: 0o600 });
    const outputs = await Promise.all([
      spawnConsumer(temp, authorityPath, one.request),
      spawnConsumer(temp, authorityPath, one.request),
    ]);
    const outcomes = outputs.map((output) => output.results[0]);
    assert.equal(outcomes.filter((result) => result.decision === 'allow').length, 1);
    assert.equal(outcomes.filter((result) => result.reason === 'replay_detected').length, 1);
    assert.equal(outputs.reduce((total, output) => total + output.effectCount, 0), 1);
    cases.push({
      caseId: 'concurrent_two_process_exactly_one_effect', expected: 'one allow and one replay block',
      actual: 'one allow and one replay block', passed: true,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return cases;
}

module.exports = Object.freeze({ invokeConsumer, spawnConsumer, cleanRoomCases, concurrentCases });
