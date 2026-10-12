'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkReleaseEvaluation } = require('../scripts/check-release-evaluation');
const {
  parseTapSummary, signReleaseEvaluation, publicationVariables, generateEvaluatorKeys, keygen, sign, main,
} = require('../scripts/sign-release-evaluation');

const INPUTS = Object.freeze({
  releaseSha: 'a'.repeat(40),
  implementationAuthors: ['author@example.test'],
  suiteDigests: { securitySuite: 'b'.repeat(64), fixtures: 'c'.repeat(64), lockfile: 'd'.repeat(64) },
});
const NOW = '2026-10-12T00:00:00.000Z';

function signed(overrides = {}) {
  const { privateKeyPem, publicKeyPem } = generateEvaluatorKeys();
  const record = signReleaseEvaluation({
    inputs: INPUTS, evaluator: 'reviewer@example.test', privateKeyPem,
    counts: { passCount: 12, failCount: 0 }, environment: 'win32 node22', acceptedRisk: 'none',
    expiresAt: '2026-10-19T00:00:00.000Z', now: NOW, ...overrides,
  });
  return { record, publicKeyPem };
}

const summary = ({ pass, fail, cancelled = 0, skipped = 0, todo = 0 }) =>
  [`# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`, `# skipped ${skipped}`, `# todo ${todo}`];

test('parseTapSummary reads the top-level pass and fail totals', () => {
  const tap = ['TAP version 13', '    # Subtest: nested', '    ok 1 - nested', '# tests 5', ...summary({ pass: 4, fail: 1 }), '']
    .join('\n');
  assert.deepEqual(parseTapSummary(tap), { passCount: 4, failCount: 1 });
});

test('parseTapSummary takes the final summary when an earlier line looks like one', () => {
  const tap = [...summary({ pass: 99, fail: 0 }), 'not ok 1 - real', ...summary({ pass: 3, fail: 1 }), ''].join('\n');
  assert.deepEqual(parseTapSummary(tap), { passCount: 3, failCount: 1 });
});

test('parseTapSummary refuses output with no summary instead of reading it as zero', () => {
  assert.throws(() => parseTapSummary('ok 1 - something\n'), /summary/);
  assert.throws(() => parseTapSummary('# pass 3\n# fail 0\n'), /summary/);
});

test('parseTapSummary refuses a run in which security tests did not run', () => {
  for (const notRun of ['skipped', 'cancelled', 'todo']) {
    assert.throws(() => parseTapSummary(summary({ pass: 5, fail: 0, [notRun]: 1 }).join('\n')),
      new RegExp(`did not all run: 1 ${notRun}`));
  }
});

test('parseTapSummary reads the summary node --test really prints with the TAP reporter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-tap-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.test.js'),
      "const { test } = require('node:test'); test('one', () => {}); test('two', () => {});\n");
    // Without dropping NODE_TEST_CONTEXT the child would talk to this runner's
    // protocol instead of printing the TAP an evaluator's terminal run prints.
    const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(dir, 'a.test.js')],
      { encoding: 'utf8', env });
    assert.deepEqual(parseTapSummary(run.stdout), { passCount: 2, failCount: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keygen writes an Ed25519 pair and never overwrites an existing key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-evalkeys-'));
  try {
    keygen(dir);
    const privatePem = fs.readFileSync(path.join(dir, 'evaluator-private.pem'), 'utf8');
    assert.equal(crypto.createPrivateKey(privatePem).asymmetricKeyType, 'ed25519');
    assert.throws(() => keygen(dir), /refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(dir, 'evaluator-private.pem'), 'utf8'), privatePem);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keygen refuses when only the public key exists, and leaves no half pair', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-evalkeys-'));
  try {
    fs.writeFileSync(path.join(dir, 'evaluator-public.pem'), 'existing');
    assert.throws(() => keygen(dir), /refusing to overwrite/);
    assert.equal(fs.existsSync(path.join(dir, 'evaluator-private.pem')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sign refuses an untracked file in the checkout before running anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-untracked-'));
  try {
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    git(['add', 'f']);
    git(['-c', 'user.email=a@example.test', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'w']);
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(path.join(dir, 'plugins', 'planted.js'), 'module.exports = {};');
    assert.throws(() => sign(['--evaluator', 'reviewer@example.test', '--key', 'missing.pem'], dir), /local changes before the run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sign refuses a checkout with local changes before running anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dirty-'));
  try {
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    git(['add', 'f']);
    git(['-c', 'user.email=a@example.test', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'w']);
    fs.writeFileSync(path.join(dir, 'f'), 'changed');
    assert.throws(() => sign(['--evaluator', 'reviewer@example.test', '--key', 'missing.pem'], dir), /local changes before the run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main reports usage errors with a failing exit code', () => {
  assert.equal(main([]), 1);
  assert.equal(main(['sign']), 1);
});

test('a signed record passes the real publication gate for the same source', () => {
  const { record, publicKeyPem } = signed();
  const result = checkReleaseEvaluation(record, { ...INPUTS, expectedEvaluator: 'reviewer@example.test',
    evaluatorPublicKey: publicKeyPem, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.recordId, record.recordId);
});

test('signing refuses an evaluator who is an implementation author', () => {
  assert.throws(() => signed({ evaluator: 'Author@Example.test' }), /independent_evaluator_required/);
});

test('signing refuses a run that recorded failures or critical findings', () => {
  assert.throws(() => signed({ counts: { passCount: 11, failCount: 1 } }), /recorded_failures_present/);
  assert.throws(() => signed({ criticalFindings: ['prompt injection bypass'] }), /evaluation_not_clear/);
});

test('signing refuses a run that observed nothing', () => {
  assert.throws(() => signed({ counts: { passCount: 0, failCount: 0 } }), /evaluation_insufficient/);
});

test('a record edited after signing no longer verifies', () => {
  const { record, publicKeyPem } = signed();
  const tampered = { ...record, acceptedRisk: 'something else' };
  const result = checkReleaseEvaluation(tampered, { ...INPUTS, expectedEvaluator: 'reviewer@example.test',
    evaluatorPublicKey: publicKeyPem, now: NOW });
  assert.equal(result.ok, false);
});

test('publicationVariables yields exactly what the publish workflow reads', () => {
  const { record, publicKeyPem } = signed();
  const vars = publicationVariables(record, publicKeyPem);
  assert.deepEqual(Object.keys(vars).sort(), [
    'HUQAN_RELEASE_EVALUATION_RECORD', 'HUQAN_RELEASE_EVALUATOR', 'HUQAN_RELEASE_EVALUATOR_PUBLIC_KEY',
  ]);
  assert.deepEqual(JSON.parse(vars.HUQAN_RELEASE_EVALUATION_RECORD), record);
  assert.equal(vars.HUQAN_RELEASE_EVALUATOR, 'reviewer@example.test');
  assert.equal(crypto.createPublicKey(vars.HUQAN_RELEASE_EVALUATOR_PUBLIC_KEY).asymmetricKeyType, 'ed25519');
});

test('signing refuses a key that is not Ed25519', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => signed({ privateKeyPem }), /Ed25519/);
});
