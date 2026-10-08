'use strict';

/**
 * Core seam for HUQAN's own-weight semantic model (R51 PR3, #3583).
 *
 * The model families and their inference live in the Application ring, so the
 * live contradiction/verify path (Core) never requires them. An entrypoint
 * registers a provider here; Core asks this port for a typed, separate model
 * signal and never mixes it into rule confidence.
 *
 * HUQAN_SEMANTIC_MODEL selects the mode:
 *   off    -> no model signal at all; outputs stay byte-identical to the rules-only path
 *   shadow -> (default) the signal is computed and reported, decisions are unchanged
 *   on     -> as shadow; a calibrated, non-ABSTAIN band may order review priority.
 *             It never rejects, blocks or overrides a rule signal.
 * An unknown value fails closed to `off`.
 *
 * Once a provider is registered, every failure (missing or corrupt artifact,
 * prediction or calibration error) becomes an ABSTAIN signal with a reason.
 * Nothing here throws into a caller.
 */

const MODES = Object.freeze(['off', 'shadow', 'on']);
const DEFAULT_MODE = 'shadow';
const LABELS = Object.freeze(['CONTRADICTION', 'ENTAILMENT', 'NEUTRAL', 'ABSTAIN']);
const BANDS = Object.freeze(['ABSTAIN', 'CONFIDENT']);
const AUTHORITY = 'CANDIDATE_ONLY';
const ARTIFACT_UNAVAILABLE = 'artifact_unavailable';
const INPUT_UNSUPPORTED = 'input_unsupported';
// Float32 weights normalised in float64; the PR1 teacher contract uses the same bound.
const DISTRIBUTION_TOLERANCE = 1e-6;

let registeredProvider = null;

function resolveSemanticModelMode(env = process.env) {
  const raw = env && env.HUQAN_SEMANTIC_MODEL;
  if (raw === undefined || raw === '') return DEFAULT_MODE;
  const mode = String(raw).trim().toLowerCase();
  return MODES.includes(mode) ? mode : 'off';
}

/** Installed once by an entrypoint; a provider maps `{stored, incoming}` to an uncalibrated prediction. */
function registerSemanticModelProvider(provider) {
  if (typeof provider !== 'function') throw new TypeError('semantic_model_provider_invalid');
  registeredProvider = provider;
}

function clearSemanticModelProvider() {
  registeredProvider = null;
}

function failureReason(error) {
  const detail = String((error && error.message) || 'unknown').slice(0, 120);
  if (error && (error.code === ARTIFACT_UNAVAILABLE || error.code === INPUT_UNSUPPORTED)) return `${error.code}:${detail}`;
  return `prediction_failed:${detail}`;
}

function abstain(mode, reason, identity = {}) {
  return Object.freeze({
    mode,
    family: identity.family || null,
    artifactDigest: identity.artifactDigest || null,
    label: 'ABSTAIN',
    p: null,
    band: 'ABSTAIN',
    calibrated: false,
    authority: AUTHORITY,
    reviewPriority: 0,
    reason,
  });
}

function validDistribution(distribution) {
  if (!distribution || typeof distribution !== 'object') return null;
  const out = {};
  for (const label of LABELS) {
    const value = distribution[label];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    out[label] = value;
  }
  const total = LABELS.reduce((sum, label) => sum + out[label], 0);
  return Math.abs(total - 1) <= DISTRIBUTION_TOLERANCE ? Object.freeze(out) : null;
}

function argmax(distribution) {
  return LABELS.reduce((best, label) => (distribution[label] > distribution[best] ? label : best), 'ABSTAIN');
}

/** A calibrator may only answer with a valid distribution and a known band; anything else is ignored. */
function applyCalibrator(calibrator, prediction) {
  if (typeof calibrator !== 'function') return null;
  const calibrated = calibrator(prediction);
  const distribution = validDistribution(calibrated && calibrated.distribution);
  if (!distribution || !BANDS.includes(calibrated.band)) return null;
  return { distribution, band: calibrated.band };
}

/**
 * `on` mode only: a calibrated, confident contradiction carries its probability
 * as a review-ordering hint. Every other case is 0, so shadow never reorders
 * and an uncalibrated model never does either. It is a hint for a reviewer's
 * queue, never a verdict.
 */
function reviewPriority(mode, band, label, p) {
  return mode === 'on' && band === 'CONFIDENT' && label === 'CONTRADICTION' ? p.CONTRADICTION : 0;
}

/**
 * The typed model signal for one claim pair, or null when the mode is `off`.
 * opts: { env, mode, provider, calibrator } -- the last three exist for tests
 * and for the calibration PR; production reads the env and the registered provider.
 */
function evaluateSemanticModel(stored, incoming, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : resolveSemanticModelMode(opts.env);
  if (mode === 'off') return null;
  // No provider means this process never wired the model (a bare Core unit,
  // not a runtime entrypoint): there is no model to report on, so no signal.
  const provider = opts.provider || registeredProvider;
  if (!provider) return null;

  let prediction;
  try {
    prediction = provider({ stored, incoming });
  } catch (error) {
    return abstain(mode, failureReason(error));
  }
  const identity = { family: prediction && prediction.family, artifactDigest: prediction && prediction.artifactDigest };
  const distribution = validDistribution(prediction && prediction.distribution);
  if (!distribution) return abstain(mode, 'prediction_failed:distribution_invalid', identity);

  let calibrated = null;
  try {
    calibrated = applyCalibrator(opts.calibrator, prediction);
  } catch (error) {
    return abstain(mode, `calibration_failed:${String((error && error.message) || 'unknown').slice(0, 120)}`, identity);
  }
  const p = calibrated ? calibrated.distribution : distribution;
  const label = argmax(p);
  const band = calibrated && label !== 'ABSTAIN' ? calibrated.band : 'ABSTAIN';
  return Object.freeze({
    mode,
    family: identity.family || null,
    artifactDigest: identity.artifactDigest || null,
    label,
    p,
    band,
    calibrated: Boolean(calibrated),
    authority: AUTHORITY,
    reviewPriority: reviewPriority(mode, band, label, p),
    reason: calibrated ? (band === 'ABSTAIN' ? 'calibrated_abstain' : null) : 'uncalibrated',
  });
}

function rank(signal) {
  return [signal.reviewPriority || 0, signal.p ? signal.p.CONTRADICTION : -1];
}

/**
 * The pair signal that matters most: a review priority (calibrated, confident,
 * mode on) outranks any raw contradiction probability; ties keep the first.
 */
function strongestSemanticModel(signals) {
  let best = null;
  for (const signal of signals) {
    if (!signal) continue;
    if (!best) { best = signal; continue; }
    const [priority, score] = rank(signal);
    const [bestPriority, bestScore] = rank(best);
    if (priority > bestPriority || (priority === bestPriority && score > bestScore)) best = signal;
  }
  return best;
}

/** The receipt-facing projection: enough to audit which weights spoke and how. */
function semanticModelReceiptView(signal) {
  if (!signal) return null;
  return Object.freeze({
    artifactDigest: signal.artifactDigest,
    family: signal.family,
    mode: signal.mode,
    band: signal.band,
    p: signal.p,
    reviewPriority: signal.reviewPriority || 0,
    reason: signal.reason,
  });
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  ARTIFACT_UNAVAILABLE,
  INPUT_UNSUPPORTED,
  resolveSemanticModelMode,
  registerSemanticModelProvider,
  clearSemanticModelProvider,
  evaluateSemanticModel,
  strongestSemanticModel,
  semanticModelReceiptView,
};
