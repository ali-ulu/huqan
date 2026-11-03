'use strict';

// The one container-detection definition (ADR-021 section 2). The bind doctor
// (#3900) and the approval-authority resolver (#4484) both read it, so the
// marker list cannot drift into two copies.
//
// Docker, Podman and systemd-nspawn each leave a marker file; Kubernetes and
// some runtimes only set an environment variable. Detection is best-effort: an
// absent marker is not evidence of a bare host. The probe is three-valued
// because "could not tell" and "not a container" are different claims and
// only the authority resolver must treat the first as unsafe (ADR-020 §11).

const fs = require('node:fs');

const CONTAINER_MARKERS = Object.freeze([
  '/.dockerenv',
  '/run/.containerenv',
  '/run/systemd/container',
]);

const CONTAINER_ENV_MARKERS = Object.freeze([
  'KUBERNETES_SERVICE_HOST',
  'container',
]);

/** True when the marker exists, false when it is absent; throws when it cannot be inspected. */
function markerExistsOnDisk(marker) {
  try {
    fs.statSync(marker);
    return true;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.environment] defaults to process.env
 * @param {(marker: string) => boolean} [opts.markerExists] throws when a marker cannot be inspected
 * @returns {'detected' | 'absent' | 'unknown'}
 */
function probeContainer({ environment = process.env, markerExists = markerExistsOnDisk } = {}) {
  let undecided = false;
  for (const marker of CONTAINER_MARKERS) {
    try {
      if (markerExists(marker)) return 'detected';
    } catch (_) {
      undecided = true;
    }
  }
  for (const name of CONTAINER_ENV_MARKERS) {
    if (environment[name]) return 'detected';
  }
  return undecided ? 'unknown' : 'absent';
}

module.exports = { CONTAINER_ENV_MARKERS, CONTAINER_MARKERS, probeContainer };
