'use strict';
// #4388 M9 value-ledger holdout runner (epic #4060). Mirrors the G1 runner
// (`lib/cognitive-lab-g1-holdout.js`): calibrate locks a manifest from the
// frozen calibration split, holdout runs once against that lock. The M9
// measurement itself is pure, so no child process is spawned; the corpus comes
// from `cognitive-lab-m9-corpus.js` and is scored by the frozen evaluator.
//
// calibrate: build the seed corpus, audit the splits, score the calibration
//   split, measure sigma from the paired Brier deltas, and lock the required
//   holdout sample. holdout: verify the lock still describes the live corpus
//   and score the holdout split exactly once.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const corpusApi = require('./cognitive-lab-m9-corpus');
const { evaluateValueLedgerRequest, walkForward, CONTRACT } = require('./cognitive-lab-m9-evaluator');

const MANIFEST_SCHEMA = 'huqan-m9-manifest-v1';
// Locked before any holdout is scored (preregistration §4): the minimum
// detectable paired-Brier improvement the power calculation is sized for, and
// the two-sided normal quantiles for alpha 0.05 / power 0.8.
const MIN_EFFECT = 0.05;
const Z_ALPHA = 1.96;
const Z_POWER = 0.84;

const sha256 = corpusApi.sha256;
const canonical = corpusApi.canonical;
const fileDigest = file => sha256(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2 || !values.every(Number.isFinite)) throw new TypeError('M9_SD_NEEDS_TWO_FINITE');
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

// Paired Brier delta per scored decision (baseline minus candidate, positive is
// better), from the same predict-then-update walk the evaluator uses.
function pairedDeltas(records, scope) {
  const walk = walkForward(records, scope);
  return walk.candidate.map((row, at) => (walk.baseline[at].probability - row.y) ** 2 - (row.probability - row.y) ** 2);
}

// The preregistered sample formula (§4): the paired decisions needed to detect
// MIN_EFFECT at the locked alpha/power, never below the contract minimum. The
// requirement is recorded honestly; if the corpus cannot supply it the holdout
// reports INSUFFICIENT rather than quietly scoring a smaller sample.
function requiredSample(sigma) {
  return Math.max(CONTRACT.minimumSamples, Math.ceil(((Z_ALPHA + Z_POWER) * sigma / MIN_EFFECT) ** 2));
}

function sourceSha() {
  try { return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' }).trim(); }
  catch { return null; }
}

function fingerprint(corpus, preregistration) {
  return { corpusDigest: corpusApi.corpusDigest(corpus),
    protocol: { ...corpus.protocol, minEffect: MIN_EFFECT, contract: { ...CONTRACT } },
    digests: { corpus: fileDigest(path.join(__dirname, 'cognitive-lab-m9-corpus.js')),
      evaluator: fileDigest(path.join(__dirname, 'cognitive-lab-m9-evaluator.js')),
      runner: fileDigest(__filename),
      preregistration: fileDigest(preregistration) } };
}

function runCalibration({ seed = corpusApi.M9_SEED, preregistration } = {}) {
  const corpus = corpusApi.buildM9Corpus({ seed });
  const audit = corpusApi.auditSplits(corpus);
  const manifest = { schemaVersion: MANIFEST_SCHEMA, phase: 'calibration', seed, sourceSha: sourceSha(),
    ...fingerprint(corpus, preregistration),
    splits: Object.fromEntries(corpusApi.SPLIT_ORDER.map(split => [split, corpus.splits[split].length])),
    audit };
  if (audit.status === 'LEAK') return { ...manifest, label: 'REJECT', reasons: ['split_leak_detected'] };
  if (audit.status !== 'CLEAN') return { ...manifest, label: 'INSUFFICIENT', reasons: ['split_audit_unavailable'] };
  const calibration = corpusApi.m9Request(corpus, { scoreSplit: 'calibration' });
  const report = evaluateValueLedgerRequest(calibration);
  const deltas = pairedDeltas(calibration.records, { workspaceId: calibration.workspaceId, asOf: calibration.asOf });
  if (report.status !== 'MEASURED' || deltas.length < CONTRACT.minimumSamples) {
    return { ...manifest, calibration: { status: report.status, reason: report.reason, paired: deltas.length },
      lock: null, label: 'INSUFFICIENT', reasons: ['calibration_below_minimum'] };
  }
  const sigma = sampleSd(deltas);
  const holdoutDecisions = corpus.splits.holdout.length;
  const required = requiredSample(sigma);
  // The anti-case (§8): the same generator with every key on one rate has no
  // per-key signal, so the lock records that a uniform profile must not gain.
  const uniform = evaluateValueLedgerRequest(corpusApi.m9Request(corpusApi.buildM9Corpus({ seed, profile: 'uniform' }), { scoreSplit: 'holdout' }));
  return { ...manifest, calibration: { status: report.status, paired: deltas.length, sigma, mean: mean(deltas),
    baselineBrier: report.pairedDelta.baseline.brier, candidateBrier: report.pairedDelta.candidate.brier },
  antiCase: { uniform: { status: uniform.status, label: uniform.h1 ? uniform.h1.label : uniform.status,
    gain: uniform.h1 ? uniform.h1.label === 'GAIN' : false } },
  lock: { requiredSample: required, powerMet: holdoutDecisions >= required, sigma, minEffect: MIN_EFFECT,
    minimumSamples: CONTRACT.minimumSamples, holdoutDecisions } };
}

// Pre-flight before the single-use marker: a refused run does not consume the
// holdout. The lock and every fingerprinted digest must still describe the live
// corpus, or the measurement would not be the preregistered one.
function checkLockedManifest(manifest, corpus, preregistration) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA || manifest.phase !== 'calibration'
    || !manifest.lock?.requiredSample || manifest.lock.requiredSample < CONTRACT.minimumSamples) {
    throw new Error('M9_HOLDOUT_NEEDS_LOCKED_MANIFEST');
  }
  const live = fingerprint(corpus, preregistration);
  const recorded = { corpusDigest: manifest.corpusDigest, protocol: manifest.protocol, digests: manifest.digests };
  for (const key of Object.keys(live)) {
    if (canonical(live[key]) !== canonical(recorded[key])) throw new Error(`M9_MANIFEST_MISMATCH:${key}`);
  }
}

function holdoutReport({ manifest, corpus, preregistration }) {
  const audit = corpusApi.auditSplits(corpus);
  const base = { schemaVersion: MANIFEST_SCHEMA, phase: 'holdout',
    claim: 'M9 value-ledger H1 measurement only (§7); better calibration is not task success',
    manifestDigest: sha256(canonical(manifest)), sourceSha: sourceSha(), seed: manifest.seed,
    audit, requiredSample: manifest.lock.requiredSample, powerMet: manifest.lock.powerMet,
    antiCases: manifest.antiCase,
    // The M9 measurement is pure: it opens no store, spawns no child and makes
    // no model or network call, so the cost is the local wall time only.
    costs: { modelCalls: 0, networkCalls: 0, coderSteps: 0, wallMs: null },
    assertsGain: false, intelligenceGain: 'NOT_MEASURED' };
  // The power calculation is part of the preregistration: a corpus too small to
  // detect the locked effect reports INSUFFICIENT, never a number.
  if (!manifest.lock.powerMet) {
    return { ...base, status: 'INSUFFICIENT', reason: 'sample_below_preregistered_power',
      coverage: { holdoutTotal: corpus.splits.holdout.length, covered: 0, uncovered: corpus.splits.holdout.length },
      h1: null, label: 'INSUFFICIENT' };
  }
  // The lock says how many paired decisions the power calculation needs; the
  // corpus supplies whole split rows, so the scored sample is the smallest
  // prefix that covers the requirement.
  const wanted = Math.min(corpus.splits.holdout.length, manifest.lock.requiredSample);
  const started = Date.now();
  const report = evaluateValueLedgerRequest(corpusApi.m9Request(corpus, { scoreSplit: 'holdout', limit: wanted }));
  return { ...base, costs: { ...base.costs, wallMs: Date.now() - started },
    coverage: report.coverage, status: report.status, reason: report.reason,
    h1: report.h1, label: report.h1 ? report.h1.label : report.status,
    pairedDelta: report.pairedDelta };
}

function runHoldout({ manifest, reportFile, preregistration }) {
  const corpus = corpusApi.buildM9Corpus({ seed: manifest?.seed });
  checkLockedManifest(manifest, corpus, preregistration);
  // The holdout opens once: 'wx' fails if any earlier attempt left a report.
  try { fs.writeFileSync(reportFile, JSON.stringify({ status: 'RUNNING', startedAt: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('M9_HOLDOUT_ALREADY_RUN'); throw error; }
  try {
    const report = holdoutReport({ manifest, corpus, preregistration });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    const failed = { schemaVersion: MANIFEST_SCHEMA, phase: 'holdout', label: 'INSUFFICIENT',
      reasons: [`holdout_run_failed:${String(error.message).slice(0, 2000)}`] };
    fs.writeFileSync(reportFile, JSON.stringify(failed, null, 2));
    return failed;
  }
}

module.exports = { MANIFEST_SCHEMA, MIN_EFFECT, requiredSample, sampleSd, pairedDeltas, fingerprint,
  runCalibration, runHoldout, checkLockedManifest, parseRunArgs };

function parseRunArgs(argv) {
  const [command, out, third, fourth] = argv;
  if (command === 'calibrate' && out) return { command, out, preregistration: third };
  if (command === 'holdout' && out && third) return { command, out, manifestFile: third, preregistration: fourth };
  return { command: null };
}

if (require.main === module) {
  const args = parseRunArgs(process.argv.slice(2));
  const log = message => process.stderr.write(`[m9] ${new Date().toISOString()} ${message}\n`);
  const defaultPrereg = path.join(__dirname, '..', 'docs', 'task-packs', 'cog-m9-holdout-preregistration-20261029.md');
  const preregistration = args.preregistration || defaultPrereg;
  if (args.command === 'calibrate') {
    log('calibrate');
    fs.writeFileSync(args.out, JSON.stringify(runCalibration({ preregistration }), null, 2));
  } else if (args.command === 'holdout') {
    log('holdout');
    runHoldout({ manifest: JSON.parse(fs.readFileSync(args.manifestFile, 'utf8')), reportFile: args.out, preregistration });
  } else {
    process.stderr.write('usage: node lib/cognitive-lab-m9-holdout.js calibrate <out.json> [preregistration] | holdout <report.json> <manifest.json> [preregistration]\n');
    process.exitCode = 2;
  }
}
