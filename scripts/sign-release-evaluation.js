#!/usr/bin/env node
'use strict';

// The evaluator's half of the #2505 release evaluation ceremony: the half
// scripts/check-release-evaluation.js verifies in the publish workflow.
//
// Run by the independent evaluator, on their own machine, at a clean checkout
// of the release tag. It runs the release security suite itself and records
// the counts it observed -- nothing is typed in by hand -- binds them to the
// checkout's SHA and digests, signs the record ID with the evaluator's Ed25519
// key, and then runs the publication gate's own check against the result, so
// a record the workflow would refuse is never handed over.
//
//   node scripts/sign-release-evaluation.js keygen <dir>
//   node scripts/sign-release-evaluation.js sign --evaluator <email> --key <private.pem>
//       [--expires-days 7] [--accepted-risk <text>] [--finding <text>]... [--out <dir>]
//
// The private key never leaves the evaluator. Only the three files written to
// --out go to the repository owner, who stores them as variables of the
// npm-publish environment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildReleaseEvaluationRecord } = require('../lib/release-evaluation-record');
const { checkReleaseEvaluation, releaseEvaluationInputs } = require('./check-release-evaluation');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXPIRY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// A security test that was skipped, cancelled or left as todo did not run, and
// a record signed over it would claim coverage nobody observed.
const NOT_RUN = Object.freeze(['cancelled', 'skipped', 'todo']);

function parseTapSummary(output) {
  const total = name => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  const totals = Object.fromEntries(['pass', 'fail', ...NOT_RUN].map(name => [name, total(name)]));
  if (Object.values(totals).some(value => value === null)) throw new Error('test output carries no complete TAP summary');
  const notRun = NOT_RUN.filter(name => totals[name] > 0).map(name => `${totals[name]} ${name}`);
  if (notRun.length) throw new Error(`security tests did not all run: ${notRun.join(', ')}`);
  return { passCount: totals.pass, failCount: totals.fail };
}

function assertCleanCheckout(root, when) {
  // Untracked files count: the security suite loads plugins from the tree, so an
  // untracked one would run during the evaluation without entering any digest.
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (dirty.trim()) throw new Error(`the checkout has local changes ${when}; evaluate a clean checkout of the release tag`);
}

function generateEvaluatorKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}

function signReleaseEvaluation({ inputs, evaluator, privateKeyPem, counts, environment, acceptedRisk = 'none',
  criticalFindings = [], expiresAt, now = new Date().toISOString() }) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the evaluator key must be Ed25519');
  const body = buildReleaseEvaluationRecord({ releaseSha: inputs.releaseSha, suiteDigests: inputs.suiteDigests,
    evaluator, environment, ...counts, criticalFindings, acceptedRisk, expiresAt });
  const record = { ...body, signature: crypto.sign(null, Buffer.from(body.recordId, 'utf8'), privateKey).toString('base64') };
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const result = checkReleaseEvaluation(record, { ...inputs, expectedEvaluator: evaluator,
    evaluatorPublicKey: publicKeyPem, now });
  if (!result.ok) throw new Error(`the publication gate would refuse this record: ${result.code}`);
  return record;
}

function publicationVariables(record, publicKeyPem) {
  return { HUQAN_RELEASE_EVALUATION_RECORD: JSON.stringify(record),
    HUQAN_RELEASE_EVALUATOR: record.evaluator, HUQAN_RELEASE_EVALUATOR_PUBLIC_KEY: publicKeyPem };
}

function runSecuritySuite(root) {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/security-release-evaluation.js'), '--test-reporter=tap'],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  process.stderr.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.error) throw run.error;
  const counts = parseTapSummary(run.stdout);
  if (run.status !== 0 && counts.failCount === 0) throw new Error(`security suite exited ${run.status} without a recorded failure`);
  return counts;
}

function keygen(dir) {
  if (!dir) throw new Error('usage: keygen <dir>');
  fs.mkdirSync(dir, { recursive: true });
  const { privateKeyPem, publicKeyPem } = generateEvaluatorKeys();
  const privatePath = path.join(dir, 'evaluator-private.pem');
  const publicPath = path.join(dir, 'evaluator-public.pem');
  // Checked up front so a refused run never leaves half a pair behind.
  for (const existing of [privatePath, publicPath]) {
    if (fs.existsSync(existing)) throw new Error(`refusing to overwrite ${existing}`);
  }
  fs.writeFileSync(privatePath, privateKeyPem, { flag: 'wx', mode: 0o600 });
  try {
    fs.writeFileSync(publicPath, publicKeyPem, { flag: 'wx' });
  } catch (error) {
    fs.rmSync(privatePath, { force: true });
    throw error;
  }
  console.log(`wrote ${dir}/evaluator-private.pem (keep it) and evaluator-public.pem`);
}

function sign(args, root = ROOT) {
  const { values } = parseArgs({ args, options: { evaluator: { type: 'string' }, key: { type: 'string' },
    'expires-days': { type: 'string' }, 'accepted-risk': { type: 'string' },
    finding: { type: 'string', multiple: true }, out: { type: 'string' } } });
  if (!values.evaluator || !values.key) throw new Error('usage: sign --evaluator <email> --key <private.pem>');
  assertCleanCheckout(root, 'before the run');
  const days = Number(values['expires-days'] ?? DEFAULT_EXPIRY_DAYS);
  if (!Number.isInteger(days) || days < 1) throw new Error('--expires-days must be a positive integer');
  const inputs = releaseEvaluationInputs(root);
  const counts = runSecuritySuite(root);
  // The digests were read before the run; a suite that edits tracked files
  // would otherwise sign evidence about a tree that no longer exists.
  assertCleanCheckout(root, 'after the run');
  const record = signReleaseEvaluation({ inputs, evaluator: values.evaluator,
    privateKeyPem: fs.readFileSync(values.key, 'utf8'), counts, criticalFindings: values.finding ?? [],
    environment: `${process.platform}-${process.arch} node ${process.version}`,
    acceptedRisk: values['accepted-risk'] ?? 'none', expiresAt: new Date(Date.now() + days * DAY_MS).toISOString() });
  const publicKeyPem = crypto.createPublicKey(fs.readFileSync(values.key, 'utf8')).export({ type: 'spki', format: 'pem' });
  // Outside the checkout by default: output inside it would make the next run's clean-tree check fail.
  // A fresh private directory, so another local user cannot pre-create or swap the files handed to `gh`.
  const out = values.out ?? fs.mkdtempSync(path.join(os.tmpdir(), `huqan-release-evaluation-${inputs.releaseSha.slice(0, 8)}-`));
  fs.mkdirSync(out, { recursive: true });
  for (const [name, value] of Object.entries(publicationVariables(record, publicKeyPem))) {
    fs.writeFileSync(path.join(out, name), value, { mode: 0o600 });
    console.log(`gh variable set ${name} --env npm-publish -R ali-ulu/huqan < "${path.join(out, name)}"`);
  }
  console.log(`signed ${record.recordId} for ${inputs.releaseSha}, expires ${record.expiresAt}`);
}

function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    if (command === 'keygen') keygen(rest[0]);
    else if (command === 'sign') sign(rest);
    else throw new Error('usage: sign-release-evaluation.js keygen <dir> | sign --evaluator <email> --key <private.pem>');
    return 0;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { parseTapSummary, generateEvaluatorKeys, signReleaseEvaluation, publicationVariables, keygen, sign, main };
