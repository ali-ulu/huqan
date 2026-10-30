'use strict';

/**
 * #4071 COG-M10 Lab runner
 * (`docs/task-packs/cog-m10-curiosity-preregistration-20261030.md` §4–§9).
 *
 * Order is the preregistered one: build the seeded corpus, calibrate on the
 * calibration split only (sigma -> nRequired), write and freeze the manifest
 * with `wx` before the holdout is opened, then run the holdout groups once for
 * both arms through the real dream→verify episode and score it.
 *
 * No clock, no randomness beyond the corpus seed: the same work directory
 * contents are reproducible. The manifest is single-use; a second run in the
 * same directory is refused rather than silently re-measured.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  buildM10Corpus, sha256, canonical,
} = require('./cognitive-lab-m10-corpus');
const { evaluateM10, lockGroupCount, sampleSd } = require('./cognitive-lab-m10-evaluator');
const { runM10Episode } = require('./cognitive-lab-m10-episode');

const MANIFEST_SCHEMA = 'huqan-m10-manifest-v1';
const MANIFEST_FILE = 'm10-manifest.json';
const REPORT_FILE = 'm10-report.json';
const PREREGISTRATION = path.join(__dirname, '..', 'docs', 'task-packs', 'cog-m10-curiosity-preregistration-20261030.md');

const fileDigest = (file) => sha256(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
const writeExclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

const M10_HELP = Object.freeze({
  usage: ['huqan-cognitive-lab m10 --m10-workdir DIR'],
  commands: {
    m10: 'Ön-kayıtlı M10 merak ölçümünü çalıştırır: seeded corpus, calibration sigma/nRequired, holdout açılmadan manifest, sonra dream→verify kolları; manifest/report DIR altına yazılır, store açmaz, assertsGain=false kalır.',
  },
});

function parseM10Args(args) {
  const [command, flag, value, ...extra] = args;
  if (command !== 'm10' || flag !== '--m10-workdir' || !value || extra.length) {
    throw new TypeError('expected m10 --m10-workdir DIR');
  }
  return { command, workDir: value };
}

function runGroups(corpus, groups) {
  const executions = { candidate: [], control: [] };
  for (const group of groups) {
    for (const arm of ['candidate', 'control']) {
      executions[arm].push(runM10Episode({ group, history: corpus.monitoringHistory, arm }));
    }
  }
  return executions;
}

const successOf = (record) => (record.attempted > 0 ? record.verified / record.attempted : 0);

/**
 * @param {{workDir: string, seed?: number, splitSizes?: object}} input
 * @returns {object} frozen report written to `<workDir>/m10-report.json`
 */
function runM10Lab({ workDir, seed, splitSizes } = {}) {
  if (typeof workDir !== 'string' || !workDir.trim()) throw new TypeError('M10_WORKDIR_REQUIRED');
  fs.mkdirSync(workDir, { recursive: true });
  const manifestPath = path.join(workDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) throw new Error('M10_MANIFEST_EXISTS');
  const corpus = buildM10Corpus({
    ...(seed === undefined ? {} : { seed }),
    ...(splitSizes === undefined ? {} : { splitSizes }),
  });

  const calibrationGroups = corpus.groups.filter((group) => group.split === 'calibration');
  const calibration = runGroups(corpus, calibrationGroups);
  const calibrationDeltas = calibration.candidate.map((record, index) =>
    successOf(record) - successOf(calibration.control[index]));
  // The preregistration derives sigma from a pilot and defines no zero-variance
  // fallback; a single calibration group cannot estimate an SD, so fail closed
  // before the manifest is written and before any holdout data is opened.
  if (calibrationDeltas.length < 2) throw new Error('M10_CALIBRATION_TOO_SMALL');
  const sigma = sampleSd(calibrationDeltas);
  const nRequired = lockGroupCount(sigma);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA, seed: corpus.seed,
    predictorVersions: corpus.predictorVersions.slice(),
    corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest,
    monitoringProbeDigest: sha256(canonical({
      probe: corpus.monitoringProbe, predictorVersions: corpus.predictorVersions, history: corpus.monitoringHistory,
    })),
    preregistrationDigest: fileDigest(PREREGISTRATION),
    sigma, nRequired, splitSizes: corpus.splitSizes,
  };
  // The manifest is frozen before the holdout is opened; no later step can
  // revise sigma or the group floor.
  writeExclusive(manifestPath, manifest);

  const holdoutGroups = corpus.groups.filter((group) => group.split === 'holdout');
  const executions = runGroups(corpus, holdoutGroups);
  const report = evaluateM10({ corpus, manifest, executions, integrity: { firewallBypass: 0, approvalBypass: 0 } });
  const output = Object.freeze({
    ...report,
    blockedSteps: [...executions.candidate, ...executions.control]
      .reduce((sum, record) => sum + record.blockedSteps, 0),
    calibration: { groups: calibrationGroups.length, sigma, nRequired },
  });
  writeExclusive(path.join(workDir, REPORT_FILE), output);
  return output;
}

module.exports = {
  MANIFEST_SCHEMA, MANIFEST_FILE, REPORT_FILE, PREREGISTRATION, M10_HELP, parseM10Args, runM10Lab, runGroups,
};
