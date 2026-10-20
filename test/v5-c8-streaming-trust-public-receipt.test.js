'use strict';

// #4087 PR-1: the pure bridge that publishes a C8 Streaming Trust receipt as a
// public trust receipt. The four behaviours below are the issue's PR-1 list,
// and each one is a rule the bridge exists to hold rather than a property of
// the exporter it delegates to.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGitHubAppBetaStore } = require('../lib/github-app-beta-store');
const { createGitHubAppStreamingTrustStore } = require('../lib/github-app-streaming-trust-store');
const { handleGitHubAppStreamingTrustWebhook } = require('../lib/github-app-streaming-trust-handler');
const { publishStreamingTrustPublicReceipt } = require('../lib/github-app-streaming-trust-public-receipt');
const {
  ERROR_CODES,
  PublicTrustReceiptError,
  importPublicTrustReceipt,
  toCanonicalPublicReceiptBytes,
} = require('../lib/receipt/public-trust-receipt');

const SECRET = 'streaming-trust-webhook-secret';
const DELIVERY = '82d3162e-cc78-11e3-81ab-4c9367dc0958';
const REPOSITORY_ID = 1300995136;
const REPOSITORY_FULL_NAME = 'ali-ulu/huqan';
const INSTALLATION_ID = 991;
const PR_NUMBER = 280;
const HEAD_SHA = 'b'.repeat(40);
const NOW_MS = Date.parse('2026-08-14T00:30:00.000Z');
const ISSUED_AT = '2026-08-14T00:31:00.000Z';
const KEY_ID = 'test-key:c8-streaming-trust-public-receipt';
const PRIVATE_MARKERS = [
  'private-title-must-not-survive',
  'private-body-token-must-not-survive',
  'private-feature-name',
  'private-user',
  'private@example.invalid',
];

function payload(overrides = {}) {
  return {
    action: 'opened',
    number: PR_NUMBER,
    installation: { id: INSTALLATION_ID },
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME, private: false },
    pull_request: {
      number: PR_NUMBER,
      title: 'private-title-must-not-survive',
      body: 'private-body-token-must-not-survive',
      head: { sha: HEAD_SHA, ref: 'private-feature-name' },
    },
    sender: { login: 'private-user', email: 'private@example.invalid' },
    ...overrides,
  };
}

function signedRequest(bodyObject, deliveryId = DELIVERY) {
  const rawBody = Buffer.from(JSON.stringify(bodyObject), 'utf8');
  return {
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
    rawBody,
    webhookSecret: SECRET,
  };
}

function responseJson(value, ok = true) {
  return { ok, async json() { return value; } };
}

function makeGitHubFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return responseJson({
        token: 'ghs_streaming_test_token',
        expires_at: '2026-08-14T01:30:00.000Z',
      });
    }
    if (url === `https://api.github.com/repos/ali-ulu/huqan/pulls/${PR_NUMBER}`) {
      return responseJson({
        number: PR_NUMBER,
        base: { repo: { id: REPOSITORY_ID, full_name: REPOSITORY_FULL_NAME } },
        head: { sha: HEAD_SHA },
      });
    }
    if (url.startsWith(`https://api.github.com/repos/ali-ulu/huqan/pulls/${PR_NUMBER}/files?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      const files = [{ filename: 'docs/streaming.md', status: 'modified', additions: 3, deletions: 1 }];
      return responseJson(files.slice((page - 1) * 100, (page - 1) * 100 + 100));
    }
    if (url === 'https://api.github.com/repos/ali-ulu/huqan/check-runs') {
      const body = JSON.parse(options.body);
      return responseJson({ id: 445566, head_sha: body.head_sha });
    }
    throw new Error(`unexpected GitHub URL: ${url}`);
  };
  return { fetchImpl, calls };
}

/**
 * Run the real C8 loop end to end and hand back the receipt it produced, so
 * the bridge is exercised against a receipt the product actually mints rather
 * than a hand-written stand-in. The C8 receipt is chained onto a C7
 * observation, which is exactly the shape `runGitHubAppStreamingTrust` stores.
 */
async function realC8Receipt(t) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-c8-public-receipt-')));
  t.after(() => fs.rmSync(rootPath, { recursive: true, force: true }));
  const result = await handleGitHubAppStreamingTrustWebhook({
    ...signedRequest(payload()),
    c7Store: createGitHubAppBetaStore({ rootPath }),
    c8Store: createGitHubAppStreamingTrustStore({ rootPath }),
    appId: '123456',
    privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    fetchImpl: makeGitHubFetch().fetchImpl,
    nowMs: NOW_MS,
  });
  return result.trust.receipt;
}

function ed25519Signer() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return { keyId: KEY_ID, privateKey };
}

// The verification a third party performs with what the check run publishes:
// the public receipt id, the internal receipt hash, and the published public
// key. Nothing else from this process is needed.
function verifyAsThirdParty(publicReceipt, publicKey) {
  return importPublicTrustReceipt(toCanonicalPublicReceiptBytes(publicReceipt), {
    expectedInternalReceiptHash: publicReceipt.binding.internalReceiptHash,
    trustedKeyRecords: [{
      keyReference: publicReceipt.integrity.signature.keyId,
      status: 'active',
      publicKeySpkiDer: publicKey.export({ format: 'der', type: 'spki' }),
    }],
    evaluationTime: publicReceipt.issuedAt,
  });
}

test('a C8 receipt is accepted as an internal receipt by the public trust receipt exporter', async (t) => {
  const internalReceipt = await realC8Receipt(t);
  const { publicReceipt, error } = publishStreamingTrustPublicReceipt({
    internalReceipt,
    issuedAt: ISSUED_AT,
    signer: ed25519Signer(),
  });

  assert.equal(error, null);
  assert.ok(publicReceipt, 'a configured signer publishes a receipt');
  assert.equal(publicReceipt.schemaVersion, 'v5-public-trust-receipt-v1');
  assert.equal(publicReceipt.issuedAt, ISSUED_AT);
  assert.equal(publicReceipt.disclosure.receiptKind, internalReceipt.receiptKind);
  assert.equal(publicReceipt.disclosure.verdict, internalReceipt.verdict);
});

test('the public receipt binds to the same receipt hash the check run shows', async (t) => {
  const internalReceipt = await realC8Receipt(t);
  const pair = crypto.generateKeyPairSync('ed25519');
  const { publicReceipt } = publishStreamingTrustPublicReceipt({
    internalReceipt,
    issuedAt: ISSUED_AT,
    signer: { keyId: KEY_ID, privateKey: pair.privateKey },
  });

  assert.equal(publicReceipt.binding.internalReceiptHash, internalReceipt.receiptHash);

  // A third party with the public key and the check-run summary can verify it:
  // the id the check run shows is the one the exporter derives, and the bytes
  // round-trip through the import a verifier would use.
  const imported = verifyAsThirdParty(publicReceipt, pair.publicKey);
  assert.equal(imported.ok, true, imported.ok ? '' : JSON.stringify(imported));
  assert.equal(imported.receipt.publicReceiptId, publicReceipt.publicReceiptId);
  assert.equal(imported.receipt.binding.internalReceiptHash, internalReceipt.receiptHash);
  assert.equal(imported.verification.signature, 'valid');
});

test('the public receipt discloses nothing from the webhook payload or repository identity', async (t) => {
  const internalReceipt = await realC8Receipt(t);
  const { publicReceipt } = publishStreamingTrustPublicReceipt({
    internalReceipt,
    issuedAt: ISSUED_AT,
    signer: ed25519Signer(),
  });

  const published = JSON.stringify(publicReceipt);
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(!published.includes(marker), `${marker} must not reach the public receipt`);
  }
  assert.ok(!published.includes(REPOSITORY_FULL_NAME), 'repository identity is not disclosed');
  assert.ok(!published.includes(REPOSITORY_ID.toString()), 'repository id is not disclosed');
  assert.deepEqual(
    Object.keys(publicReceipt.disclosure).sort(),
    ['createdAt', 'decision', 'receiptKind', 'riskScore', 'status', 'trustPolicyVersion', 'verdict'],
  );
});

test('a missing signer skips publication without changing the verdict', async (t) => {
  const internalReceipt = await realC8Receipt(t);
  const skipped = publishStreamingTrustPublicReceipt({
    internalReceipt,
    issuedAt: ISSUED_AT,
    signer: null,
  });

  assert.equal(skipped.publicReceipt, null);
  assert.equal(skipped.error, null, 'not configured is not a failure');
  assert.equal(internalReceipt.verdict, 'allow', 'the receipt the loop already decided is untouched');

  // A publication failure is reported, not thrown: the caller keeps its verdict.
  const failed = publishStreamingTrustPublicReceipt({
    internalReceipt,
    issuedAt: ISSUED_AT,
    signer: { keyId: KEY_ID, privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey },
  });
  assert.equal(failed.publicReceipt, null);
  assert.ok(failed.error instanceof PublicTrustReceiptError);
  assert.equal(failed.error.code, ERROR_CODES.INVALID_SIGNER);
});
