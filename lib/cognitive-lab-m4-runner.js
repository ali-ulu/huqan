'use strict';

/**
 * #4070 COG-M4 Lab runner
 * (`docs/task-packs/cog-m4-retention-preregistration-20261031.md` §4–§9).
 *
 * Order is the preregistered one: build the seeded corpus, calibrate on the
 * calibration split only (sigma -> nRequired), write and freeze the manifest
 * with `wx` before the holdout is opened, then run the holdout groups once for
 * both arms through the real consolidate/archive path and score it.
 *
 * No clock, no randomness beyond the corpus seed: the same work directory
 * contents are reproducible. The manifest is single-use; a second run in the
 * same directory is refused rather than silently re-measured.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildM4Corpus } = require('./cognitive-lab-m4-corpus');
const { evaluateM4, lockGroupCount, sampleSd } = require('./cognitive-lab-m4-evaluator');
const { runM4Episode } = require('./cognitive-lab-m4-episode');

const MANIFEST_SCHEMA = 'huqan-m4-manifest-v1';
const MANIFEST_FILE = 'm4-manifest.json';
const REPORT_FILE = 'm4-report.json';
// Frozen at PR time. The packaging contract forbids shipping docs/*, so an
// installed run cannot read the document; a repo test pins this value to its
// sha256 so the manifest still names the exact preregistration it was locked to.
const PREREGISTRATION_DIGEST = 'b3de08208ac5befaf8bac055001332d6f620c127b0e63b9d82cb92d74904285d';
const writeExclusive = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

const M4_HELP = Object.freeze({
  usage: ['huqan-cognitive-lab m4 --m4-workdir DIR'],
  commands: {
    m4: 'Ön-kayıtlı M4 unutma (retention) ölçümünü çalıştırır: seeded corpus, calibration sigma/nRequired, holdout açılmadan manifest, sonra gerçek consolidate/archive kolları; manifest/report DIR altına yazılır, store açmaz, assertsGain=false kalır.',
  },
});

function parseM4Args(args) {
  const [command, flag, value, ...extra] = args;
  if (command !== 'm4' || flag !== '--m4-workdir' || !value || extra.length) {
    throw new TypeError('expected m4 --m4-workdir DIR');
  }
  return { command, workDir: value };
}

function runGroups(groups) {
  const executions = { candidate: [], control: [] };
  for (const group of groups) {
    for (const arm of ['candidate', 'control']) {
      executions[arm].push(runM4Episode({ group, arm }));
    }
  }
  return executions;
}

const recallOf = (record) => (record.queries > 0 ? record.recallHits / record.queries : 0);

/**
 * @param {{workDir: string, seed?: number, splitSizes?: object}} input
 * @returns {object} frozen report written to `<workDir>/m4-report.json`
 */
function runM4Lab({ workDir, seed, splitSizes } = {}) {
  if (typeof workDir !== 'string' || !workDir.trim()) throw new TypeError('M4_WORKDIR_REQUIRED');
  fs.mkdirSync(workDir, { recursive: true });
  const manifestPath = path.join(workDir, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) throw new Error('M4_MANIFEST_EXISTS');
  // A report without a manifest means a previous run wrote the report and then
  // failed before, or was interrupted after, the manifest was removed. Either
  // way the directory is already spent; refuse before the corpus or manifest so
  // the exclusive report write cannot fail and strand a fresh manifest behind.
  if (fs.existsSync(path.join(workDir, REPORT_FILE))) throw new Error('M4_REPORT_EXISTS');
  const corpus = buildM4Corpus({
    ...(seed === undefined ? {} : { seed }),
    ...(splitSizes === undefined ? {} : { splitSizes }),
  });

  const calibrationGroups = corpus.groups.filter((group) => group.split === 'calibration');
  const calibration = runGroups(calibrationGroups);
  const calibrationDeltas = calibration.candidate.map((record, index) =>
    recallOf(record) - recallOf(calibration.control[index]));
  // The preregistration derives sigma from a pilot and defines no zero-variance
  // fallback; a single calibration group cannot estimate an SD, so fail closed
  // before the manifest is written and before any holdout data is opened.
  if (calibrationDeltas.length < 2) throw new Error('M4_CALIBRATION_TOO_SMALL');
  const sigma = sampleSd(calibrationDeltas);
  const nRequired = lockGroupCount(sigma);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA, seed: corpus.seed, now: corpus.now, recallK: corpus.recallK,
    corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest,
    preregistrationDigest: PREREGISTRATION_DIGEST,
    sigma, nRequired, splitSizes: corpus.splitSizes,
  };
  // The manifest is frozen before the holdout is opened; no later step can
  // revise sigma or the group floor.
  writeExclusive(manifestPath, manifest);

  const holdoutGroups = corpus.groups.filter((group) => group.split === 'holdout');
  const executions = runGroups(holdoutGroups);
  const report = evaluateM4({ corpus, manifest, executions, integrity: { firewallBypass: 0, approvalBypass: 0 } });
  const output = Object.freeze({
    ...report,
    calibration: { groups: calibrationGroups.length, sigma, nRequired },
    preregistrationDigest: PREREGISTRATION_DIGEST,
  });
  writeExclusive(path.join(workDir, REPORT_FILE), output);
  return output;
}

module.exports = {
  MANIFEST_SCHEMA, MANIFEST_FILE, REPORT_FILE, PREREGISTRATION_DIGEST, M4_HELP, parseM4Args, runM4Lab, runGroups,
};
