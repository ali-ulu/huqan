'use strict';

/**
 * The first thing HUQAN observes for itself.
 *
 * `metadata.effectVerification` was introduced as an honesty label: an outcome
 * receipt says `reported` because the status came from the executor, and
 * `observed` existed only so a verifier could reject an unknown value. Nothing
 * produced `observed`. The label was correct and empty.
 *
 * This fills one class of it. When an action names a file, the guard hashes
 * that file at admission and again at outcome. Both readings are taken by
 * HUQAN, from the filesystem, so the conclusion does not depend on what the
 * executor said happened:
 *
 *   digest before != digest after   ->  the file changed
 *   absent -> present               ->  the file was created
 *   present -> absent               ->  the file was removed
 *   identical                       ->  nothing changed, whatever was reported
 *
 * That last line is the useful one. A caller reporting success on an action
 * that changed nothing is exactly the gap between `reported` and `observed`,
 * and it is now visible in the receipt rather than taken on trust.
 *
 * ## What it does not establish
 *
 * That the change was the *right* one. A file that changed is evidence an
 * effect occurred, not evidence the goal was met -- and a file that did not
 * change is not proof of failure either, since an action can legitimately be a
 * no-op. The receipt records what was measured; reading intent into it is the
 * error this field exists to prevent.
 *
 * It also sees exactly one target. An action that writes three files is
 * observed on the one the envelope names, and the receipt says so rather than
 * implying whole-action coverage.
 *
 * ## Bounded, and never fatal
 *
 * A digest is refused above MAX_OBSERVED_BYTES: hashing an arbitrarily large
 * file on the admission path would turn an observation into a stall. Any error
 * -- unreadable, permission denied, a path that is a directory -- answers
 * `unreadable` rather than throwing, because a sensor that can fail the action
 * it measures is worse than no sensor.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

const FILE_EFFECT_SENSOR_VERSION = 'huqan.file-effect-sensor.v1';

/** 8 MiB: large enough for source and config, small enough not to stall a gate. */
const MAX_OBSERVED_BYTES = 8 * 1024 * 1024;

const FILE_STATES = Object.freeze({
  ABSENT: 'absent',
  UNREADABLE: 'unreadable',
  TOO_LARGE: 'too_large',
  DIGESTED: 'digested',
});

const EFFECT_OBSERVATIONS = Object.freeze({
  CREATED: 'created',
  REMOVED: 'removed',
  MODIFIED: 'modified',
  UNCHANGED: 'unchanged',
  INDETERMINATE: 'indeterminate',
});

/**
 * Read one file's state, without ever throwing.
 *
 * @param {string} filePath
 * @returns {{state: string, digest: string|null, bytes: number|null}}
 */
function observeFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { state: FILE_STATES.UNREADABLE, digest: null, bytes: null };
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    // ENOENT is a real observation -- the file is not there -- and every other
    // error is an admission that we could not look.
    return error && error.code === 'ENOENT'
      ? { state: FILE_STATES.ABSENT, digest: null, bytes: null }
      : { state: FILE_STATES.UNREADABLE, digest: null, bytes: null };
  }
  if (!stats.isFile()) return { state: FILE_STATES.UNREADABLE, digest: null, bytes: null };
  if (stats.size > MAX_OBSERVED_BYTES) {
    return { state: FILE_STATES.TOO_LARGE, digest: null, bytes: stats.size };
  }
  try {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return { state: FILE_STATES.DIGESTED, digest, bytes: stats.size };
  } catch (_) {
    return { state: FILE_STATES.UNREADABLE, digest: null, bytes: stats.size };
  }
}

/**
 * What the two readings say happened.
 *
 * `indeterminate` whenever either reading failed or was refused: an observation
 * we could not take must not be reported as an observation we did.
 *
 * @param {object} before result of observeFile at admission
 * @param {object} after result of observeFile at outcome
 * @returns {string} one of EFFECT_OBSERVATIONS
 */
function compareObservations(before, after) {
  if (!before || !after) return EFFECT_OBSERVATIONS.INDETERMINATE;
  const readable = new Set([FILE_STATES.ABSENT, FILE_STATES.DIGESTED]);
  if (!readable.has(before.state) || !readable.has(after.state)) return EFFECT_OBSERVATIONS.INDETERMINATE;

  if (before.state === FILE_STATES.ABSENT && after.state === FILE_STATES.DIGESTED) return EFFECT_OBSERVATIONS.CREATED;
  if (before.state === FILE_STATES.DIGESTED && after.state === FILE_STATES.ABSENT) return EFFECT_OBSERVATIONS.REMOVED;
  if (before.state === FILE_STATES.ABSENT && after.state === FILE_STATES.ABSENT) return EFFECT_OBSERVATIONS.UNCHANGED;
  return before.digest === after.digest ? EFFECT_OBSERVATIONS.UNCHANGED : EFFECT_OBSERVATIONS.MODIFIED;
}

/**
 * Did HUQAN actually see the effect, or is it still taking the caller's word?
 *
 * `indeterminate` deliberately answers false: the whole point of the field is
 * that it never claims more than was measured.
 *
 * @param {string} observation
 * @returns {boolean}
 */
function isObserved(observation) {
  return observation === EFFECT_OBSERVATIONS.CREATED
    || observation === EFFECT_OBSERVATIONS.REMOVED
    || observation === EFFECT_OBSERVATIONS.MODIFIED
    || observation === EFFECT_OBSERVATIONS.UNCHANGED;
}

module.exports = {
  FILE_EFFECT_SENSOR_VERSION,
  MAX_OBSERVED_BYTES,
  FILE_STATES,
  EFFECT_OBSERVATIONS,
  observeFile,
  compareObservations,
  isObserved,
};
