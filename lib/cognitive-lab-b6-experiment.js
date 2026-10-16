'use strict';

/**
 * B6 scheduler ablation runner (#3311 / #3562, program #3306).
 *
 * The pure evaluator (`lib/cognitive-lab-b6-evaluator.js`) scores paired
 * ablation records. This module wraps it in the Cognitive Lab measurement
 * contract the preregistration asks for (§11/§15): it emits a frozen
 * `huqan-cognitive-lab-manifest-v1` with `mechanisms.B6 = 'ENABLED'` (every
 * other mechanism `NOT_MEASURED`), derives the split from the records, and
 * returns the evaluator report alongside the manifest.
 *
 * The corpus is supplied by the caller: building it drives the real AgentV3
 * loop, which lives in the test harness, not in a domain module. This module
 * stays a pure function over `records`, so it can be called from a lab surface
 * without dragging the agent runtime into the domain layer.
 *
 * The output is candidate-only: `authority` is MODEL_AUTHORITY and `canonical`
 * is false. A verdict is an experimental ranking, never a promoted rule, and no
 * code path here promotes one.
 */

const { MANIFEST_SCHEMA_VERSION, buildManifest, computeManifestDigest, MECHANISM_IDS } = require('./cognitive-lab-manifest');
const { evaluate, CONTRACT } = require('./cognitive-lab-b6-evaluator');

const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const MECHANISM_FLAGS = Object.freeze({ B6: 'ENABLED' });

function mechanismsReport() {
  return Object.freeze(Object.fromEntries(MECHANISM_IDS.map((id) => [id, MECHANISM_FLAGS[id] || 'NOT_MEASURED'])));
}

function splitIdsOf(records) {
  const ids = { train: [], holdout: [], transfer: [] };
  for (const record of records) {
    if (!Object.prototype.hasOwnProperty.call(ids, record.split)) throw new TypeError(`unknown split ${record.split}`);
    ids[record.split].push(record.taskId);
  }
  for (const split of Object.values(ids)) split.sort();
  return ids;
}

/**
 * Run the B6 measurement contract over a set of paired ablation records.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records one observation per task; the
 *   evaluator rejects a record whose solved flag disagrees with the steps.
 * @param {string} input.corpusDigest the frozen corpus digest (64 lowercase hex)
 * @param {string} input.sourceCommit the 40-char Git SHA the run is pinned to
 * @param {boolean} input.sourceDirty the explicit dirty state of that commit
 * @param {number} [input.seed] manifest seed; defaults to the contract seed
 * @param {object} [input.contract] the preregistered contract; defaults to the
 *   frozen `CONTRACT`. It is re-locked inside the evaluator regardless.
 * @returns {Readonly<object>} `{ status, reason, assertsGain, authority,
 *   canonical, mechanisms, manifest, manifestDigest, report }`.
 */
function runB6Experiment({ records, corpusDigest, sourceCommit, sourceDirty, seed, contract = CONTRACT } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError('records are required');
  if (typeof corpusDigest !== 'string' || !/^[a-f0-9]{64}$/.test(corpusDigest)) throw new TypeError('corpus digest required');
  if (!SOURCE_COMMIT.test(sourceCommit || '')) throw new TypeError('source commit required');
  if (typeof sourceDirty !== 'boolean') throw new TypeError('explicit source dirty state required');

  const splitIds = splitIdsOf(records);
  const manifestSeed = seed === undefined ? contract.seed : seed;
  const { manifest, digest } = buildManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: sourceCommit, dirty: sourceDirty },
    fixture: { digest: corpusDigest },
    split: { identity: computeManifestDigest(splitIds), ...splitIds },
    frame: { repository: 'ali-ulu/huqan', branch: 'experiment', environment: 'offline', task: 'B6-scheduler-ablation' },
    seed: manifestSeed,
    mechanisms: mechanismsReport(),
    budget: { modelCalls: records.length * 2, toolCalls: 0, humanCalls: 0, tokens: 0, wallTimeMs: null, compute: null },
    measurementVersion: 'cognitive-lab-b6-v1',
    thresholdConfigHash: computeManifestDigest(contract),
  });

  const report = evaluate(records, contract);
  return Object.freeze({
    schemaVersion: 'huqan-cognitive-lab-b6-experiment-v1',
    authority: 'MODEL_AUTHORITY',
    canonical: false,
    automaticPromotion: false,
    status: report.status,
    reason: report.reason,
    assertsGain: report.assertsGain,
    mechanisms: mechanismsReport(),
    intelligenceGain: 'NOT_MEASURED',
    manifest,
    manifestDigest: digest,
    report,
  });
}

module.exports = { runB6Experiment, mechanismsReport, splitIdsOf, MECHANISM_FLAGS };
