'use strict';

/**
 * #4071 COG-M10 Lab corpus
 * (`docs/task-packs/cog-m10-curiosity-preregistration-20261030.md` §4–§5).
 *
 * A seeded, deterministic synthetic corpus with group-level splits. The
 * monitoring history is built only from the `monitor` split and carries the
 * frozen probe set (probeSetId + frameRef) with two predictor versions, so
 * learning progress is measurable. Holdout groups carry candidate hypotheses
 * plus the verification oracle the episode seeds into its graph; their oracle
 * values never enter the monitoring history or the ranker.
 *
 * The corpus is a controlled fixture: a GAIN label on it is a pipeline
 * result, not a production learning claim.
 */

const { createHash } = require('node:crypto');
const { createPairedSampler: mulberry32 } = require('./cognitive-lab-paired-delta');
const { LP_WINDOW } = require('./cognition/curiosity');

const SCHEMA_VERSION = 'huqan-m10-corpus-v1';
const SEED = 40710;
const MONITORING_PROBE = Object.freeze({ probeSetId: 'm10-monitor-p1', frameRef: 'frame-m10-v1' });
const PREDICTOR_VERSIONS = Object.freeze(['m10-p1', 'm10-p2']);
const REGIONS = Object.freeze(['yapabilir', 'benzer']);
const SPLITS = Object.freeze(['monitor', 'calibration', 'holdout']);
// The holdout is sized above the power floor the preregistration predicts for
// this corpus (sigma ~0.27 -> N ~233); a smaller holdout is a legitimate
// INSUFFICIENT, never a gain.
const SPLIT_SIZES = Object.freeze({ monitor: 8, calibration: 16, holdout: 256 });
const CANDIDATES_PER_REGION = 3;
const MONITOR_AT = Object.freeze(['2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]));
});
const round6 = (value) => Math.round(value * 1e6) / 1e6;

// Frozen monitoring history: one LP_WINDOW record per predictor version. The
// "yapabilir" region improves (0.8 -> 0.2); "benzer" is flat but noisy, so the
// ranker's noise guard must zero its curiosity rather than promote it.
function monitoringHistory() {
  const errors = {
    yapabilir: [Array(LP_WINDOW).fill(0.8), Array(LP_WINDOW).fill(0.2)],
    benzer: [Array(LP_WINDOW).fill(0.5), [1, 0, 1, 0]],
  };
  const rows = [];
  for (const region of REGIONS) {
    PREDICTOR_VERSIONS.forEach((predictorVersion, index) => rows.push({
      region, probeSetId: MONITORING_PROBE.probeSetId, predictorVersion, frameRef: MONITORING_PROBE.frameRef,
      at: MONITOR_AT[index], errors: errors[region][index],
      verificationSourceRefs: [`monitor:${region}:${predictorVersion}`], coverage: 1,
      sourceGroup: `monitor-${region}`,
    }));
  }
  return rows;
}

function validateSizes(splitSizes) {
  if (!splitSizes || typeof splitSizes !== 'object') throw new TypeError('M10_SPLIT_SIZES_INVALID');
  const sizes = {};
  for (const split of SPLITS) {
    const size = splitSizes[split];
    if (!Number.isInteger(size) || size < 1 || size > 512) throw new TypeError(`M10_SPLIT_SIZE_INVALID:${split}`);
    sizes[split] = size;
  }
  if (sizes.holdout < 1) throw new TypeError('M10_HOLDOUT_EMPTY');
  return sizes;
}

/**
 * @param {{seed?: number, splitSizes?: object}} options
 * @returns {Readonly<object>} deterministic corpus with corpusDigest/groupDigest
 */
function buildM10Corpus({ seed = SEED, splitSizes = SPLIT_SIZES } = {}) {
  if (!Number.isInteger(seed)) throw new TypeError('M10_SEED_INVALID');
  const sizes = validateSizes(splitSizes);
  const random = mulberry32(seed);
  const groups = [];
  let index = 0;
  for (const split of SPLITS) {
    for (let position = 0; position < sizes[split]; position += 1) {
      index += 1;
      const sourceGroup = `m10-g-${String(index).padStart(3, '0')}`;
      const candidates = [];
      for (const region of REGIONS) {
        // Per-candidate difficulty, equal across regions: the improving region
        // is more likely to verify, which is exactly the mechanism H1 measures.
        // The evaluator's drift guard still checks that selection did not
        // simply go to easier candidates.
        const oracleBase = region === 'yapabilir' ? 0.9 : 0.6;
        for (let slot = 0; slot < CANDIDATES_PER_REGION; slot += 1) {
          const difficulty = round6(0.2 + random() * 0.6);
          const probability = Math.min(0.95, Math.max(0.05, oracleBase - 0.5 * difficulty));
          candidates.push({
            key: sha256(`${sourceGroup}|${region}|${slot}`).slice(0, 16),
            from: `düğüm-${index}-${region}-${slot}`,
            to: `hedef-${index}-${region}-${slot}`,
            relation: region,
            region,
            confidence: round6(0.1 + random() * 0.9),
            difficulty,
            oracle: random() < probability,
          });
        }
      }
      const difficulty = round6(candidates.reduce((sum, candidate) => sum + candidate.difficulty, 0) / candidates.length);
      groups.push({ sourceGroup, split, difficulty, candidates });
    }
  }
  const corpus = {
    schemaVersion: SCHEMA_VERSION, seed, monitoringProbe: { ...MONITORING_PROBE },
    predictorVersions: PREDICTOR_VERSIONS.slice(), splitSizes: { ...sizes },
    groups, monitoringHistory: monitoringHistory(),
  };
  const corpusDigest = sha256(canonical(corpus));
  const groupDigest = sha256(canonical(groups.map((group) => [group.sourceGroup, group.split, group.difficulty,
    group.split === 'holdout' ? group.candidates.map((candidate) => Number(candidate.oracle)) : null])));
  return Object.freeze({ ...corpus, corpusDigest, groupDigest });
}

const holdoutGroups = (corpus) => corpus.groups.filter((group) => group.split === 'holdout').map((group) => group.sourceGroup);

module.exports = {
  SCHEMA_VERSION,
  SEED,
  MONITORING_PROBE,
  PREDICTOR_VERSIONS,
  REGIONS,
  SPLIT_SIZES,
  CANDIDATES_PER_REGION,
  sha256,
  canonical,
  buildM10Corpus,
  holdoutGroups,
};
