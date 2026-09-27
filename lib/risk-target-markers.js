'use strict';

/**
 * Production-destination detection for the action risk classifier.
 *
 * A destination can be spelled as a bare token (`value: 'production'`,
 * `env: 'live'`) or as a path inside the envelope's target. Both readings
 * live here so the classifier does not grow by one more inline helper every
 * time a target shape is added (issue #328 file-size ratchet).
 */

// Whole-segment match, not a substring test: `lib/producer.js` is not a
// production destination, but `srv/prod/app.js` is.
const PRODUCTION_PATH_MARKERS = Object.freeze(['prod', 'production', 'live', 'canonical']);

function hasProductionPathSegment(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) {
    return false;
  }
  return pathValue
    .split(/[\\/]+/)
    .some((segment) => PRODUCTION_PATH_MARKERS.includes(segment.trim().toLowerCase()));
}

function looksLikeProductionTarget(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const values = [target.value, target.env, target.scope, target.target]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  if (values.some((value) => PRODUCTION_PATH_MARKERS.includes(value))) {
    return true;
  }
  // The envelope carries a destination under `path` as often as under `value`
  // (lib/external-action-envelope.js sets target.path/resolvedPath from the
  // tool args). A write aimed at a production directory is production-side
  // however it is spelled, so the path is read here too.
  return hasProductionPathSegment(target.path) || hasProductionPathSegment(target.resolvedPath);
}

module.exports = {
  PRODUCTION_PATH_MARKERS,
  hasProductionPathSegment,
  looksLikeProductionTarget,
};
