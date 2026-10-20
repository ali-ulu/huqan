'use strict';

/**
 * Strict resolver for the single AgentV3 opt-in namespace `opts.cognition` (#4060 S3).
 * Pure Core: no I/O, no clock, no randomness. Unknown keys, non-boolean values and
 * impossible flag combinations are REJECTed and then every flag resolves to off, so a
 * bad config can never half-enable cognition. An absent namespace is all-off.
 */

const { COGNITION_STATUS, AUTHORITY, freezeResult } = require('./contract');

const COGNITION_FLAGS = Object.freeze([
  'predictionError', // M2
  'reward', // M8
  'value', // M9
  'percept', // M1
  'salience', // M7
  'workingMemory', // M11
  'workspace', // M6
  'dualProcess', // M5
  'curiosity', // M10
]);

/** Hard module dependencies from the plan's phase graph (section 4). */
const FLAG_REQUIRES = freezeResult({
  reward: ['predictionError'],
  value: ['reward'],
  percept: ['predictionError'],
  salience: ['percept', 'predictionError', 'value'],
  workingMemory: ['salience'],
  workspace: ['workingMemory'],
  dualProcess: ['predictionError', 'value', 'salience'],
  curiosity: ['predictionError'],
});

const allOff = () => Object.fromEntries(COGNITION_FLAGS.map((flag) => [flag, false]));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function collectReasons(config) {
  const reasons = [];
  for (const key of Object.keys(config)) {
    if (!COGNITION_FLAGS.includes(key)) reasons.push(`unknown_flag:${key}`);
    else if (typeof config[key] !== 'boolean') reasons.push(`invalid_type:${key}`);
  }
  for (const flag of COGNITION_FLAGS) {
    if (config[flag] !== true) continue;
    for (const dep of FLAG_REQUIRES[flag] || []) {
      if (config[dep] !== true) reasons.push(`missing_dependency:${flag}->${dep}`);
    }
  }
  return reasons;
}

/**
 * @param {unknown} config the `opts.cognition` value (undefined/null means all off)
 * @returns {Readonly<{status: string, authority: string, flags: object, anyEnabled: boolean, reasons: string[]}>}
 */
function resolveCognitionConfig(config) {
  const done = (status, flags, reasons) =>
    freezeResult({
      status,
      authority: AUTHORITY.SIGNAL_ONLY,
      flags,
      anyEnabled: COGNITION_FLAGS.some((flag) => flags[flag]),
      reasons,
    });
  if (config === undefined || config === null) return done(COGNITION_STATUS.MEASURED, allOff(), []);
  if (!isPlainObject(config)) return done(COGNITION_STATUS.REJECT, allOff(), ['invalid_namespace']);
  const reasons = collectReasons(config);
  if (reasons.length > 0) return done(COGNITION_STATUS.REJECT, allOff(), reasons);
  return done(COGNITION_STATUS.MEASURED, { ...allOff(), ...config }, []);
}

module.exports = { COGNITION_FLAGS, FLAG_REQUIRES, resolveCognitionConfig };
