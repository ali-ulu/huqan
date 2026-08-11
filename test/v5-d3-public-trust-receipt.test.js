'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hashCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { encodeJsonStableV1 } = require('../lib/v5/cryptographic-profile-contract');
const {
  ERROR_CODES,
  MAX_PUBLIC_RECEIPT_BYTES,
  PUBLIC_RECEIPT_SIGNATURE_DOMAIN,
  PublicTrustReceiptError,
  computePublicReceiptChecksum,
  exportPublicTrustReceipt,
  importPublicTrustReceipt,
  readPublicTrustReceiptFile,
  toCanonicalPublicReceiptBytes,
  writePublicTrustReceiptFile,
} = require('../lib/v5/public-trust-receipt');

const ROOT = path.join(__dirname, '..');
const BUNDLE_PATH = path.join(
  ROOT,
  'specs',
  'axiom-trust-protocol',
  '0.1',
  'examples',
  'receipt-bundle.valid.json',
);
const C4_FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'v5',
  'public-trust-receipt',
  'valid.public-receipt.json',
);
const REDACTION_POLICY_PATH = path.join(
  ROOT,
  'schemas',
  'v5',
  'public-receipt-redaction-policy.json',
);
const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
const internalReceipt = bundle.receipts[0];
const redactionPolicy = JSON.parse(fs.readFileSync(REDACTION_POLICY_PATH, 'utf8'));
const EVALUATION_TIME = '2026-08-11T00:00:00.000Z';
const KEY_ID = 'test-key:d3-public-receipt';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function publicDer(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' });
}

function makeReceipt(keys = keyPair(), overrides = {}) {
  return {
    keys,
    receipt: exportPublicTrustReceipt({
      internalReceipt,
      issuedAt: EVALUATION_TIME,
      signer: { keyId: KEY_ID, privateKey: keys.privateKey },
      sourceBundle: bundle,
      ...overrides,
    }),
  };
}

function trustedRecord(keys, overrides = {}) {
  return {
    keyReference: KEY_ID,
    status: 'active',
    publicKeySpkiDer: publicDer(keys.publicKey),
    ...overrides,
  };
}

function importOptions(keys, overrides = {}) {
  return {
    expectedInternalReceiptHash: internalReceipt.receiptHash,
    expectedBundleHash: bundle.bundleHash,
    trustedKeyRecords: [trustedRecord(keys)],
    evaluationTime: EVALUATION_TIME,
    ...overrides,
  };
}

function canonicalBytes(receipt) {
  return encodeJsonStableV1(receipt);
}

function reseal(receipt) {
  receipt.integrity.checksum = computePublicReceiptChecksum(receipt);
  return canonicalBytes(receipt);
}

function assertRejected(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, code);
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('V5-D3 export: fixed disclosure and explicit signature projection', () => {
  it('exports a real signed receipt whose checksum covers the signature', () => {
    const { receipt } = makeReceipt();
    assert.equal(receipt.integrity.signed, true);
    assert.equal(receipt.integrity.signature.profileId, 'ed25519-v1');
    assert.match(receipt.integrity.signature.value, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(receipt.integrity.checksum, computePublicReceiptChecksum(receipt));
    assert.equal(PUBLIC_RECEIPT_SIGNATURE_DOMAIN, 'HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1');
  });

  it('constructs exactly the policy allowlist and withholds every private surface', () => {
    const { receipt } = makeReceipt();
    assert.deepEqual(Object.keys(receipt.disclosure), redactionPolicy.disclosableFields);
    const serialized = JSON.stringify(receipt);
    for (const field of [
      'workspaceId', 'actor', 'agentId', 'admissionId', 'memoryDraftId',
      'provenanceId', 'approvalId', 'reason', 'metadata', 'previousReceiptHash',
    ]) {
      assert.equal(Object.hasOwn(receipt.disclosure, field), false, field);
      assert.doesNotMatch(serialized, new RegExp(`"${field}"`));
    }
  });

  it('rejects a tampered source receipt before projection', () => {
    const tampered = clone(internalReceipt);
    tampered.decision = 'block';
    const keys = keyPair();
    assert.throws(
      () => exportPublicTrustReceipt({
        internalReceipt: tampered,
        issuedAt: EVALUATION_TIME,
        signer: { keyId: KEY_ID, privateKey: keys.privateKey },
      }),
      (error) => error instanceof PublicTrustReceiptError
        && error.code === ERROR_CODES.INVALID_INTERNAL_RECEIPT,
    );
  });

  it('fails closed when a future internal field is added', () => {
    const future = clone(internalReceipt);
    future.futurePrivateField = 'must never cross the boundary';
    const { receiptHash, ...withoutHash } = future;
    future.receiptHash = hashCanonicalReceiptPayload(withoutHash);
    const keys = keyPair();
    assert.throws(
      () => exportPublicTrustReceipt({
        internalReceipt: future,
        issuedAt: EVALUATION_TIME,
        signer: { keyId: KEY_ID, privateKey: keys.privateKey },
      }),
      (error) => error.code === ERROR_CODES.INVALID_INTERNAL_RECEIPT,
    );
  });

  it('rejects a secret-looking allowlisted value instead of scrubbing and signing it', () => {
    const secret = clone(internalReceipt);
    secret.status = 'sk-aaaaaaaaaaaa';
    const { receiptHash, ...withoutHash } = secret;
    secret.receiptHash = hashCanonicalReceiptPayload(withoutHash);
    const keys = keyPair();
    assert.throws(
      () => exportPublicTrustReceipt({
        internalReceipt: secret,
        issuedAt: EVALUATION_TIME,
        signer: { keyId: KEY_ID, privateKey: keys.privateKey },
      }),
      (error) => error.code === ERROR_CODES.SECRET_DETECTED,
    );
  });

  it('requires a valid source bundle that contains the selected receipt', () => {
    const changed = clone(bundle);
    changed.receipts = [];
    changed.bundleHash = crypto.createHash('sha256')
      .update(JSON.stringify(changed.receipts))
      .digest('hex');
    const keys = keyPair();
    assert.throws(
      () => exportPublicTrustReceipt({
        internalReceipt,
        issuedAt: EVALUATION_TIME,
        signer: { keyId: KEY_ID, privateKey: keys.privateKey },
        sourceBundle: changed,
      }),
      (error) => [
        ERROR_CODES.INVALID_SOURCE_BUNDLE,
        ERROR_CODES.SOURCE_RECEIPT_NOT_IN_BUNDLE,
      ].includes(error.code),
    );
  });

  it('accepts only an Ed25519 private KeyObject and serializes no private material', () => {
    const ed = keyPair();
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const privateKey of [
      ed.publicKey,
      rsa.privateKey,
      ed.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      null,
    ]) {
      assert.throws(
        () => exportPublicTrustReceipt({
          internalReceipt,
          issuedAt: EVALUATION_TIME,
          signer: { keyId: KEY_ID, privateKey },
        }),
        (error) => error.code === ERROR_CODES.INVALID_SIGNER,
      );
    }
    const receipt = exportPublicTrustReceipt({
      internalReceipt,
      issuedAt: EVALUATION_TIME,
      signer: { keyId: KEY_ID, privateKey: ed.privateKey },
    });
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE KEY|privateKey|pkcs8|secret/i);
  });

  it('rejects a secret-looking public keyId instead of signing and disclosing it', () => {
    const keys = keyPair();
    assert.throws(
      () => exportPublicTrustReceipt({
        internalReceipt,
        issuedAt: EVALUATION_TIME,
        signer: { keyId: 'sk-aaaaaaaaaaaa', privateKey: keys.privateKey },
      }),
      (error) => error.code === ERROR_CODES.SECRET_DETECTED,
    );
  });
});

describe('V5-D3 import: independent binding, key lifecycle and Ed25519', () => {
  it('verifies canonical bytes with independently supplied receipt and bundle hashes', () => {
    const { keys, receipt } = makeReceipt();
    const result = importPublicTrustReceipt(
      toCanonicalPublicReceiptBytes(receipt),
      importOptions(keys),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.verification, {
      checksum: 'valid',
      binding: 'matched_independently',
      keyState: 'active',
      signature: 'valid',
    });
  });

  it('also accepts an independently verified source bundle binding', () => {
    const { keys, receipt } = makeReceipt();
    const options = importOptions(keys);
    delete options.expectedBundleHash;
    options.sourceBundle = bundle;
    assert.equal(importPublicTrustReceipt(canonicalBytes(receipt), options).ok, true);
  });

  it('never trusts only the hashes asserted inside the artifact', () => {
    const { keys, receipt } = makeReceipt();
    const missingReceiptBinding = importOptions(keys);
    delete missingReceiptBinding.expectedInternalReceiptHash;
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(receipt), missingReceiptBinding),
      ERROR_CODES.BINDING_MISMATCH,
    );

    const missingBundleBinding = importOptions(keys);
    delete missingBundleBinding.expectedBundleHash;
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(receipt), missingBundleBinding),
      ERROR_CODES.BUNDLE_BINDING_REQUIRED,
    );
  });

  it('rejects wrong independently supplied receipt and bundle hashes', () => {
    const { keys, receipt } = makeReceipt();
    const wrong = 'f'.repeat(64);
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(receipt), importOptions(keys, {
        expectedInternalReceiptHash: wrong,
      })),
      ERROR_CODES.BINDING_MISMATCH,
    );
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(receipt), importOptions(keys, {
        expectedBundleHash: wrong,
      })),
      ERROR_CODES.BUNDLE_BINDING_MISMATCH,
    );
  });

  it('rejects an unsigned C4 artifact instead of reporting it verified', () => {
    const unsigned = JSON.parse(fs.readFileSync(C4_FIXTURE_PATH, 'utf8'));
    const keys = keyPair();
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(unsigned), importOptions(keys)),
      ERROR_CODES.UNSIGNED,
    );
  });

  it('rejects disclosure mutation even when the attacker recomputes the checksum', () => {
    const { keys, receipt } = makeReceipt();
    const forged = clone(receipt);
    forged.disclosure.decision = 'block';
    assertRejected(
      importPublicTrustReceipt(reseal(forged), importOptions(keys)),
      ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it('rejects an attacker re-signing with an untrusted key under the trusted keyId', () => {
    const trusted = keyPair();
    const attacker = keyPair();
    const receipt = exportPublicTrustReceipt({
      internalReceipt,
      issuedAt: EVALUATION_TIME,
      signer: { keyId: KEY_ID, privateKey: attacker.privateKey },
      sourceBundle: bundle,
    });
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(receipt), importOptions(trusted)),
      ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it('binds keyId into the signature projection', () => {
    const { keys, receipt } = makeReceipt();
    const changed = clone(receipt);
    changed.integrity.signature.keyId = 'test-key:d3-substituted';
    const options = importOptions(keys, {
      trustedKeyRecords: [{
        keyReference: 'test-key:d3-substituted',
        status: 'active',
        publicKeySpkiDer: publicDer(keys.publicKey),
      }],
    });
    assertRejected(
      importPublicTrustReceipt(reseal(changed), options),
      ERROR_CODES.SIGNATURE_INVALID,
    );
  });

  it('rejects a secret-looking keyId on import before key lookup', () => {
    const { keys, receipt } = makeReceipt();
    const changed = clone(receipt);
    changed.integrity.signature.keyId = 'sk-aaaaaaaaaaaa';
    assertRejected(
      importPublicTrustReceipt(reseal(changed), importOptions(keys)),
      ERROR_CODES.SECRET_DETECTED,
    );
  });

  it('rejects malformed and noncanonical signature encodings', () => {
    const { keys, receipt } = makeReceipt();
    for (const value of [
      `${receipt.integrity.signature.value}=`,
      receipt.integrity.signature.value.slice(0, -1),
      `+${receipt.integrity.signature.value.slice(1)}`,
    ]) {
      const changed = clone(receipt);
      changed.integrity.signature.value = value;
      assertRejected(
        importPublicTrustReceipt(reseal(changed), importOptions(keys)),
        ERROR_CODES.INVALID_RECEIPT,
      );
    }
  });

  it('fails closed for every non-active or ambiguous key lifecycle state', () => {
    const { keys, receipt } = makeReceipt();
    const bytes = canonicalBytes(receipt);
    const cases = [
      { name: 'unknown', records: [] },
      { name: 'revoked', records: [trustedRecord(keys, { status: 'revoked' })] },
      { name: 'unavailable', records: [trustedRecord(keys, { status: 'unavailable' })] },
      { name: 'expired-state', records: [trustedRecord(keys, { status: 'expired' })] },
      {
        name: 'expired-equality',
        records: [trustedRecord(keys, { expiresAt: EVALUATION_TIME })],
      },
      {
        name: 'duplicate',
        records: [trustedRecord(keys), trustedRecord(keys)],
      },
      {
        name: 'malformed-private-field',
        records: [{ ...trustedRecord(keys), privateKey: 'forbidden' }],
      },
    ];
    for (const testCase of cases) {
      const result = importPublicTrustReceipt(bytes, importOptions(keys, {
        trustedKeyRecords: testCase.records,
      }));
      assertRejected(result, ERROR_CODES.KEY_NOT_ACTIVE);
    }
  });

  it('accepts an active key strictly before its expiration boundary', () => {
    const { keys, receipt } = makeReceipt();
    const result = importPublicTrustReceipt(canonicalBytes(receipt), importOptions(keys, {
      trustedKeyRecords: [trustedRecord(keys, { expiresAt: '2026-08-11T00:00:00.001Z' })],
    }));
    assert.equal(result.ok, true);
  });

  it('checks checksum before observing trusted-key records', () => {
    const { receipt } = makeReceipt();
    const changed = clone(receipt);
    changed.disclosure.status = 'changed-without-checksum';
    let reads = 0;
    const options = {
      expectedInternalReceiptHash: internalReceipt.receiptHash,
      expectedBundleHash: bundle.bundleHash,
      evaluationTime: EVALUATION_TIME,
      get trustedKeyRecords() {
        reads += 1;
        throw new Error('must not execute');
      },
    };
    assertRejected(
      importPublicTrustReceipt(canonicalBytes(changed), options),
      ERROR_CODES.CHECKSUM_INVALID,
    );
    assert.equal(reads, 0);
  });

  it('returns a defensive frozen copy', () => {
    const { keys, receipt } = makeReceipt();
    const sourceBytes = canonicalBytes(receipt);
    const result = importPublicTrustReceipt(sourceBytes, importOptions(keys));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.receipt), true);
    assert.equal(Object.isFrozen(result.receipt.disclosure), true);
    assert.throws(() => { result.receipt.disclosure.status = 'mutated'; }, TypeError);
    assert.equal(result.receipt.disclosure.status, receipt.disclosure.status);
  });
});

describe('V5-D3 import: canonical bounded wire and exact shape', () => {
  it('rejects whitespace, alternate order, duplicate keys and trailing data', () => {
    const { keys, receipt } = makeReceipt();
    const canonical = canonicalBytes(receipt).toString('utf8');
    const cases = [
      ` ${canonical}`,
      JSON.stringify(receipt),
      canonical + '\n',
      canonical.replace('{', `{"schemaVersion":"${receipt.schemaVersion}",`),
    ];
    for (const wire of cases) {
      assertRejected(
        importPublicTrustReceipt(Buffer.from(wire), importOptions(keys)),
        ERROR_CODES.NON_CANONICAL,
      );
    }
  });

  it('rejects oversize, invalid UTF-8 and non-byte inputs', () => {
    const keys = keyPair();
    assertRejected(
      importPublicTrustReceipt(Buffer.alloc(MAX_PUBLIC_RECEIPT_BYTES + 1, 0x20), importOptions(keys)),
      ERROR_CODES.SIZE_LIMIT,
    );
    assertRejected(importPublicTrustReceipt(Buffer.from([0xff]), importOptions(keys)), ERROR_CODES.NON_CANONICAL);
    assertRejected(importPublicTrustReceipt('{}', importOptions(keys)), ERROR_CODES.NON_CANONICAL);
  });

  it('rejects unknown fields at every object nesting level', () => {
    const { keys, receipt } = makeReceipt();
    const mutations = [
      (value) => { value.futureRoot = true; },
      (value) => { value.disclosure.futureDisclosure = true; },
      (value) => { value.binding.futureBinding = true; },
      (value) => { value.integrity.futureIntegrity = true; },
      (value) => { value.integrity.signature.futureSignature = true; },
    ];
    for (const mutate of mutations) {
      const changed = clone(receipt);
      mutate(changed);
      changed.integrity.checksum = computePublicReceiptChecksum(changed);
      assertRejected(
        importPublicTrustReceipt(canonicalBytes(changed), importOptions(keys)),
        ERROR_CODES.INVALID_RECEIPT,
      );
    }
  });
});

describe('V5-D3 file boundary and process round-trip', () => {
  it('round-trips a real Ed25519 artifact across two independent Node processes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d3-process-'));
    const receiptPath = path.join(directory, 'public-receipt.json');
    const publicKeyPath = path.join(directory, 'public-key.txt');
    const modulePath = path.join(ROOT, 'lib', 'v5', 'public-trust-receipt.js');

    const exporter = `
      const crypto=require('node:crypto');
      const fs=require('node:fs');
      const m=require(process.argv[1]);
      const bundle=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      const keys=crypto.generateKeyPairSync('ed25519');
      const receipt=m.exportPublicTrustReceipt({
        internalReceipt:bundle.receipts[0],
        issuedAt:'${EVALUATION_TIME}',
        signer:{keyId:'${KEY_ID}',privateKey:keys.privateKey},
        sourceBundle:bundle
      });
      m.writePublicTrustReceiptFile(process.argv[3],receipt);
      fs.writeFileSync(process.argv[4],keys.publicKey.export({format:'der',type:'spki'}).toString('base64url'),{flag:'wx'});
    `;
    const exportRun = spawnSync(process.execPath, [
      '-e', exporter, modulePath, BUNDLE_PATH, receiptPath, publicKeyPath,
    ], { encoding: 'utf8' });
    assert.equal(exportRun.status, 0, exportRun.stderr);

    const importer = `
      const fs=require('node:fs');
      const m=require(process.argv[1]);
      const bundle=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      const publicKey=Buffer.from(fs.readFileSync(process.argv[4],'utf8'),'base64url');
      const result=m.readPublicTrustReceiptFile(process.argv[3],{
        expectedInternalReceiptHash:bundle.receipts[0].receiptHash,
        expectedBundleHash:bundle.bundleHash,
        trustedKeyRecords:[{keyReference:'${KEY_ID}',status:'active',publicKeySpkiDer:publicKey}],
        evaluationTime:'${EVALUATION_TIME}'
      });
      process.stdout.write(JSON.stringify(result));
      process.exitCode=result.ok?0:2;
    `;
    const importRun = spawnSync(process.execPath, [
      '-e', importer, modulePath, BUNDLE_PATH, receiptPath, publicKeyPath,
    ], { encoding: 'utf8' });
    assert.equal(importRun.status, 0, importRun.stderr);
    assert.equal(JSON.parse(importRun.stdout).status, 'verified');
  });

  it('leaves an existing target byte-for-byte unchanged', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d3-existing-'));
    const target = path.join(directory, 'existing.json');
    fs.writeFileSync(target, 'owner-data', { flag: 'wx' });
    const { receipt } = makeReceipt();
    assert.throws(
      () => writePublicTrustReceiptFile(target, receipt),
      (error) => error.code === ERROR_CODES.TARGET_EXISTS,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'owner-data');
  });

  it('allows exactly one of two concurrent writers to create the target', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d3-race-'));
    const source = path.join(directory, 'source.json');
    const target = path.join(directory, 'winner.json');
    const { receipt } = makeReceipt();
    fs.writeFileSync(source, toCanonicalPublicReceiptBytes(receipt), { flag: 'wx' });
    const modulePath = path.join(ROOT, 'lib', 'v5', 'public-trust-receipt.js');
    const writer = `
      const fs=require('node:fs');
      const m=require(process.argv[1]);
      const receipt=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      try { m.writePublicTrustReceiptFile(process.argv[3],receipt); process.stdout.write('won'); }
      catch (error) { process.stdout.write(error.code); process.exitCode=3; }
    `;
    const children = [0, 1].map(() => spawn(
      process.execPath,
      ['-e', writer, modulePath, source, target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    const results = await Promise.all(children.map(childResult));
    assert.equal(results.filter((result) => result.code === 0 && result.stdout === 'won').length, 1);
    assert.equal(results.filter((result) => (
      result.code === 3 && result.stdout === ERROR_CODES.TARGET_EXISTS
    )).length, 1);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
  });

  it('rejects a symlink or junction parent and target', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d3-link-'));
    const realParent = path.join(directory, 'real');
    const linkedParent = path.join(directory, 'linked');
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    const { keys, receipt } = makeReceipt();
    assert.throws(
      () => writePublicTrustReceiptFile(path.join(linkedParent, 'receipt.json'), receipt),
      (error) => error.code === ERROR_CODES.UNSAFE_PATH,
    );

    const realTarget = path.join(realParent, 'real.json');
    writePublicTrustReceiptFile(realTarget, receipt);
    const linkedTarget = path.join(realParent, 'linked.json');
    if (process.platform === 'win32') {
      fs.mkdirSync(path.join(realParent, 'target-directory'));
      fs.symlinkSync(path.join(realParent, 'target-directory'), linkedTarget, 'junction');
    } else {
      fs.symlinkSync(realTarget, linkedTarget, 'file');
    }
    assertRejected(readPublicTrustReceiptFile(linkedTarget, importOptions(keys)), ERROR_CODES.UNSAFE_PATH);
    assert.throws(
      () => writePublicTrustReceiptFile(linkedTarget, receipt),
      (error) => error.code === ERROR_CODES.TARGET_EXISTS,
    );
  });

  it('maps atomic no-follow symlink errors to the unsafe-path verdict', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d3-nofollow-'));
    const loop = path.join(directory, 'loop.json');
    fs.symlinkSync(loop, loop, process.platform === 'win32' ? 'junction' : 'file');
    const keys = keyPair();
    assertRejected(
      readPublicTrustReceiptFile(loop, importOptions(keys)),
      ERROR_CODES.UNSAFE_PATH,
    );
  });
});
