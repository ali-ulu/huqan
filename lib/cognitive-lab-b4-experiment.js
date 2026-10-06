'use strict';

/**
 * B4 learned-procedure-transfer lab runner (#3310 / #3562, program #3306).
 *
 * The pure evaluator (`lib/cognitive-lab-b4-evaluator.js`) scores paired
 * transfer records. This module wraps it in the Cognitive Lab measurement
 * contract the preregistration asks for (§15): it emits the frozen
 * `huqan-cognitive-lab-manifest-v1` with `mechanisms.B4 = 'ENABLED'` (every
 * other mechanism `NOT_MEASURED`) and returns the evaluator report alongside it.
 *
 * The manifest shape is the one #3456 sealed: the train split is the sealed
 * source-operation ids, the holdout/transfer splits are the task ids, and the
 * fixture/split identity is the corpus digest. The manifest is data over the
 * frozen corpus, so its digest is stable and a tampered flag is rejected before
 * any outcome is scored.
 *
 * The corpus is supplied by the caller: building it drives the real coder
 * runtime, which lives in the test harness, not in a domain module. This module
 * stays a pure function over `records`, so it can be called from a lab surface
 * without dragging the runtime into the domain layer.
 *
 * The output is candidate-only: `authority` is MODEL_AUTHORITY and `canonical`
 * is false. A verdict is an experimental ranking, never a promoted rule, and no
 * code path here promotes one.
 */

const { MANIFEST_SCHEMA_VERSION, buildManifest, computeManifestDigest } = require('./cognitive-lab-manifest');
const { evaluate, CONTRACT, ARMS, B4_MANIFEST_SEED, MECHANISM_IDS, mechanismsReport } = require('./cognitive-lab-b4-evaluator');

const SOURCE_COMMIT = /^[a-f0-9]{40}$/;

function splitIdsOf(records, trainIds = []) {
  const ids = { train: [...trainIds], holdout: [], transfer: [] };
  for (const record of records) {
    if (!Object.prototype.hasOwnProperty.call(ids, record.split)) throw new TypeError(`unknown split ${record.split}`);
    ids[record.split].push(record.taskId);
  }
  for (const split of Object.values(ids)) split.sort();
  return ids;
}

/**
 * Run the B4 measurement contract over a set of paired transfer records.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records one observation per task; the
 *   evaluator rejects a record whose binary outcome disagrees with its change set.
 * @param {string} input.corpusDigest the frozen corpus digest (64 lowercase hex)
 * @param {string} input.sourceCommit the 40-char Git SHA the run is pinned to
 * @param {boolean} input.sourceDirty the explicit dirty state of that commit
 * @param {ReadonlyArray<string>} [input.trainIds] the frozen train split ids
 *   (the sealed source-operation ids); a manifest without them is INSUFFICIENT
 * @param {number} [input.seed] manifest seed; defaults to the frozen B4 seed
 * @param {object} [input.contract] the preregistered contract; defaults to the
 *   frozen `CONTRACT`. It is re-locked inside the evaluator regardless.
 * @param {ReadonlyArray<object>} [input.tasks] the frozen task list, used by the
 *   evaluator's split-leakage check
 * @param {Iterable<string>} [input.trainContents] the train target contents
 * @returns {Readonly<object>} `{ status, reason, assertsGain, authority,
 *   canonical, mechanisms, manifest, manifestDigest, report }`.
 */
function runB4Experiment({ records, corpusDigest, sourceCommit, sourceDirty, seed, trainIds = [],
  contract = CONTRACT, tasks = [], trainContents = [] } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError('records are required');
  if (typeof corpusDigest !== 'string' || !/^[a-f0-9]{64}$/.test(corpusDigest)) throw new TypeError('corpus digest required');
  if (!SOURCE_COMMIT.test(sourceCommit || '')) throw new TypeError('source commit required');
  if (typeof sourceDirty !== 'boolean') throw new TypeError('explicit source dirty state required');

  const splitIds = splitIdsOf(records, trainIds);
  const manifestSeed = seed === undefined ? B4_MANIFEST_SEED : seed;
  const { manifest, digest } = buildManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: sourceCommit, dirty: sourceDirty },
    fixture: { digest: corpusDigest },
    split: { identity: corpusDigest, ...splitIds },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'offline', task: 'B4-procedure-transfer' },
    seed: manifestSeed,
    mechanisms: mechanismsReport(),
    budget: { modelCalls: records.length * ARMS.length, toolCalls: 0, humanCalls: 0, tokens: null, wallTimeMs: null, compute: null },
    measurementVersion: 'cognitive-lab-v0.2',
    thresholdConfigHash: computeManifestDigest(contract),
  });

  const report = evaluate(records, contract, { tasks, trainContents });
  return Object.freeze({
    schemaVersion: 'huqan-cognitive-lab-b4-experiment-v1',
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

module.exports = { runB4Experiment, splitIdsOf, MECHANISM_IDS };
