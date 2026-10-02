'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildReleaseEvaluationRecord } = require('../lib/release-evaluation-record');
const { checkReleaseEvaluation, main } = require('../scripts/check-release-evaluation');

test('publication evaluation binds source, suite, identity and expiry, and fails closed', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const sign = fields => {
    const body = buildReleaseEvaluationRecord(fields);
    return { ...body, signature: crypto.sign(null, Buffer.from(body.recordId), privateKey).toString('base64') };
  };
  const input = { releaseSha: 'a'.repeat(40), suiteDigests: { securitySuite: 'b'.repeat(64) },
    implementationAuthor: 'author@example.test', expectedEvaluator: 'reviewer@example.test',
    evaluatorPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), now: '2026-10-03' };
  const fields = { ...input, evaluator: input.expectedEvaluator, environment: 'release-review',
    passCount: 10, failCount: 0, criticalFindings: [], acceptedRisk: 'none', expiresAt: '2026-10-04' };
  const record = sign(fields);
  assert.equal(checkReleaseEvaluation(record, input).ok, true);
  assert.equal(checkReleaseEvaluation(null, input).ok, false);
  assert.equal(checkReleaseEvaluation({ ...record, version: 'unknown' }, input).code, 'record_version_mismatch');
  assert.equal(checkReleaseEvaluation(record, { ...input, releaseSha: 'c'.repeat(40) }).code, 'release_sha_mismatch');
  assert.equal(checkReleaseEvaluation(record, { ...input, suiteDigests: { securitySuite: 'c'.repeat(64) } }).code,
    'suite_digest_mismatch');
  assert.equal(checkReleaseEvaluation(record, { ...input, implementationAuthor: input.expectedEvaluator }).code,
    'independent_evaluator_required');
  assert.equal(checkReleaseEvaluation(record, { ...input, now: '2026-10-05' }).code, 'record_expired');
  assert.equal(checkReleaseEvaluation(sign({ ...fields, failCount: 1 }), input).ok, false);
  assert.equal(checkReleaseEvaluation(sign({ ...fields, criticalFindings: ['unresolved'] }), input).ok, false);
  assert.equal(checkReleaseEvaluation({ ...record, signature: '' }, input).code, 'evaluator_signature_invalid');
  assert.equal(checkReleaseEvaluation(record, { ...input, implementationAuthors: [input.expectedEvaluator] }).code,
    'independent_evaluator_required');
});

test('the real publish workflow enforces the evaluation before npm publish', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish.yml'), 'utf8');
  const gate = workflow.indexOf('run: node scripts/check-release-evaluation.js');
  assert.ok(gate > 0);
  assert.ok(gate < workflow.indexOf('          npm publish --access public'));
  assert.equal(main({}), 1);
});
