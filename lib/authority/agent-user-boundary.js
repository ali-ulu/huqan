'use strict';

// Whether agents run as a separate OS user, in their own session (#3948,
// ADR-017). ADR-016 moved the approval authority behind a service boundary and
// reports `boundary: same-user` in legacy mode so that gap stays visible. It
// left residual risks 1-4 open, all of which reduce to one fact: agents still
// run as the operator. ADR-017 decides they run as a separate local standard
// Windows user. This module reports that decision the same way `same-user` is
// reported today -- a boundary value read live, not a claim in a document.
//
// The marker, not the document, is the evidence. ADR-017 authorises no runtime
// change by itself; the split is only real once the split exists on the
// machine. `install-agent-user.ps1` writes a marker under the protected state
// root when it creates the user, and this module reports `os-user` only when
// that marker is present AND its path still has the ACL the installer set.
//
// That trust step matters for the same reason it does for the authority pin
// (lib/authority/install-trust.js): the default ProgramData ACL lets a standard
// user create a subfolder, so a same-user agent could plant a marker and read
// back the stronger `os-user` against a split that was never made. A planted
// marker is checked against its live owner and DACL and refused if a broad
// identity can write it, exactly like a planted pin. Anything that cannot be
// verified fails closed to `same-user`: the weaker value is the safe one to
// report, because it keeps the gap visible rather than hiding it.

const fs = require('node:fs');
const path = require('node:path');
const { checkPathTrust } = require('./install-trust');

// Same protected root the ADR names for the memory store (item 3): a directory
// the agent user's token cannot write, ACL'd to the operator and SYSTEM.
const DEFAULT_WINDOWS_STATE_DIR = 'C:\\ProgramData\\huqan\\state';
const DEFAULT_WINDOWS_MARKER_PATH = path.win32.join(DEFAULT_WINDOWS_STATE_DIR, 'agent-boundary.json');

// Not an OS-boundary name by accident: `os-service` is the authority service
// (ADR-016), `env-override` is an authority the environment chose, and
// `same-user` is the legacy fallback. `os-user` names the agent split.
const AGENT_BOUNDARY = 'os-user';
const SAME_USER = 'same-user';

const MARKER_VERSION = 'huqan.agent-boundary.v1';

/**
 * Read and shape-check the marker file. A marker that is absent, unreadable,
 * malformed or of the wrong version is not evidence of a split; the caller
 * decides fail-closed, but the parse itself never throws on the hot path.
 */
function readMarker(markerPath, readFile) {
  let text;
  try {
    text = readFile(markerPath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? { absent: true } : { reason: 'marker_unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { reason: 'marker_malformed' };
  }
  // The marker names the user and session split. A v1 marker with no user is
  // not a description of a split and is refused rather than read optimistically.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== MARKER_VERSION
    || typeof parsed.agentUser !== 'string' || !parsed.agentUser.trim()) {
    return { reason: 'marker_malformed' };
  }
  return { marker: parsed };
}

/**
 * Resolve the agent-user boundary for this machine.
 *
 * @returns {{value: string, reason?: string}}
 *   `value` is `os-user` only when the marker is present and trusted; otherwise
 *   `same-user`, with `reason` naming why the stronger value was not reported.
 */
function resolveAgentUserBoundary({
  platform = process.platform,
  readFile = file => fs.readFileSync(file, 'utf8'),
  checkTrust = checkPathTrust,
  markerPath = DEFAULT_WINDOWS_MARKER_PATH,
  stateDir = DEFAULT_WINDOWS_STATE_DIR,
} = {}) {
  if (platform !== 'win32') return { value: SAME_USER, reason: 'not_windows' };
  const read = readMarker(markerPath, readFile);
  if (read.absent) return { value: SAME_USER, reason: 'no_marker' };
  if (!read.marker) return { value: SAME_USER, reason: read.reason };
  // The marker parses, but a planted marker parses too. Trust the live owner and
  // DACL of the state directory and the marker, never the file content alone.
  let trusted = false;
  try {
    trusted = checkTrust([stateDir, markerPath]).ok === true;
  } catch (error) {
    trusted = false;
  }
  if (!trusted) return { value: SAME_USER, reason: 'marker_untrusted' };
  return { value: AGENT_BOUNDARY, agentUser: read.marker.agentUser };
}

module.exports = {
  AGENT_BOUNDARY,
  DEFAULT_WINDOWS_MARKER_PATH,
  DEFAULT_WINDOWS_STATE_DIR,
  MARKER_VERSION,
  SAME_USER,
  resolveAgentUserBoundary,
};
