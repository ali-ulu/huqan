'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyReleaseEvaluationRecord, EVALUATION_RECORD_VERSION } = require('../lib/release-evaluation-record');
const { selectedTests } = require('./security-release-evaluation');

function digestFiles(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

function releaseEvaluationInputs(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const fixtureFiles = git(['ls-files', 'test/fixtures', 'fixtures']).split(/\r?\n/).filter(Boolean);
  let priorRelease;
  try { priorRelease = git(['describe', '--tags', '--match', 'v*', '--abbrev=0', 'HEAD^']); } catch { priorRelease = null; }
  const implementationAuthors = [...new Set(git(['log', '--format=%ae', ...(priorRelease ? [`${priorRelease}..HEAD`] : [])])
    .split(/\r?\n/).filter(Boolean))];
  return { releaseSha: git(['rev-parse', 'HEAD']), implementationAuthors,
    suiteDigests: { securitySuite: digestFiles(root, ['scripts/run-tests.js', ...selectedTests()]),
      fixtures: digestFiles(root, fixtureFiles), lockfile: digestFiles(root, ['package-lock.json']) } };
}

function checkReleaseEvaluation(record, { releaseSha, implementationAuthor, implementationAuthors = [],
  expectedEvaluator, evaluatorPublicKey, suiteDigests, now } = {}) {
  const verified = verifyReleaseEvaluationRecord(record, { now });
  if (!verified.valid || verified.failed) return { ok: false, code: verified.reason };
  if (record.version !== EVALUATION_RECORD_VERSION) return { ok: false, code: 'record_version_mismatch' };
  if (!expectedEvaluator || record.evaluator !== expectedEvaluator
    || [...implementationAuthors, implementationAuthor].filter(Boolean)
      .some(author => record.evaluator.toLowerCase() === author.toLowerCase())) {
    return { ok: false, code: 'independent_evaluator_required' };
  }
  try {
    const key = crypto.createPublicKey(evaluatorPublicKey);
    if (key.asymmetricKeyType !== 'ed25519' || typeof record.signature !== 'string'
      || !crypto.verify(null, Buffer.from(record.recordId, 'utf8'), key, Buffer.from(record.signature, 'base64'))) {
      return { ok: false, code: 'evaluator_signature_invalid' };
    }
  } catch { return { ok: false, code: 'evaluator_signature_invalid' }; }
  if (record.releaseSha !== releaseSha) return { ok: false, code: 'release_sha_mismatch' };
  if (!suiteDigests || Object.entries(suiteDigests).some(([name, digest]) => record.suiteDigests[name] !== digest)) {
    return { ok: false, code: 'suite_digest_mismatch' };
  }
  if (record.passCount === 0 || record.criticalFindings.length > 0) {
    return { ok: false, code: 'evaluation_not_clear' };
  }
  return { ok: true, recordId: record.recordId };
}

function main(env = process.env, root = path.resolve(__dirname, '..')) {
  try {
    const record = JSON.parse(env.HUQAN_RELEASE_EVALUATION_RECORD || 'null');
    const input = releaseEvaluationInputs(root);
    const result = checkReleaseEvaluation(record, { ...input, expectedEvaluator: env.HUQAN_RELEASE_EVALUATOR,
      evaluatorPublicKey: env.HUQAN_RELEASE_EVALUATOR_PUBLIC_KEY });
    if (!result.ok) { console.error(`FAIL release evaluation: ${result.code}`); return 1; }
    console.log(`PASS release evaluation: ${result.recordId} ${input.releaseSha}`);
    return 0;
  } catch {
    console.error('FAIL release evaluation: unavailable or malformed evidence');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { digestFiles, releaseEvaluationInputs, checkReleaseEvaluation, main };
