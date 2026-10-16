'use strict';

// Shared resolution of the API-auth opt-out (#3018).
//
// HUQAN_DISABLE_API_AUTH trades the API key for convenience, and the opt-out
// is only safe while the server answers on loopback. A non-loopback bind plus
// the opt-out previously produced a fully unauthenticated server behind a
// single console.warn, the one fail-open path in an otherwise fail-closed
// posture. The unsafe combination is now a boot error unless the operator
// also sets HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE=true|1.
//
// This module owns the semantics; requestGuards reads the resolved state,
// server-boot and the container bootstrap enforce it before a listener can
// start, and cli-doctor reports it as a finding. It never reads process.env
// directly: callers pass their environment object so tests and embedded
// runtimes stay explicit.

const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const API_AUTH_OPT_OUT_VALUES = new Set(['true', '1']);
const REMOTE_OPT_IN_VALUES = new Set(['true', '1']);

// server.js binds `HOST || 127.0.0.1`; the container bootstrap writes an
// explicit 0.0.0.0 before this resolver runs, so an unset value here means
// the plain-server loopback default, not an unspecified bind.
const DEFAULT_SERVER_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '::ffff:127.0.0.1']);

function isLoopbackHost(host) {
  const value = String(host == null ? '' : host).trim().toLowerCase();
  if (!value) return false;
  if (LOOPBACK_HOSTS.has(value)) return true;
  // Dotted quad: loopback iff the first octet is 127. Hostnames other than
  // `localhost` are treated as non-loopback (fail-closed on ambiguity).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.startsWith('127.');
  return false;
}

function resolvedApiAuthHost(environment = process.env) {
  const raw = readCompatibleEnvironmentVariable('HOST', environment);
  const value = raw == null ? '' : String(raw).trim();
  return value || DEFAULT_SERVER_HOST;
}

// Single-operator installs that bind to loopback can trade the API key for
// convenience. The opt-out is deliberately explicit and off by default, so a
// fresh clone is never served unauthenticated by accident.
function isApiAuthOptOutSet(environment = process.env) {
  const raw = readCompatibleEnvironmentVariable('DISABLE_API_AUTH', environment) || '';
  return API_AUTH_OPT_OUT_VALUES.has(String(raw).trim().toLowerCase());
}

function isApiAuthRemoteOptInSet(environment = process.env) {
  const raw = readCompatibleEnvironmentVariable('DISABLE_API_AUTH_ALLOW_REMOTE', environment) || '';
  return REMOTE_OPT_IN_VALUES.has(String(raw).trim().toLowerCase());
}

let apiAuthOptOutAnnounced = false;

function announceApiAuthOptOutOnce({ host, remoteOptIn = false } = {}) {
  if (apiAuthOptOutAnnounced) return;
  apiAuthOptOutAnnounced = true;
  if (remoteOptIn) {
    console.warn('[auth] HUQAN_DISABLE_API_AUTH is set with HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE; every API request is served without authentication');
  } else {
    console.warn('[auth] HUQAN_DISABLE_API_AUTH is set; every API request is served without authentication');
  }
  if (host !== undefined) {
    console.warn(`[auth] API bind is ${host}; the opt-out is intended for loopback-only installs`);
  }
}

// Resolved, warning-emitting view consumed by requestGuards and runtime-status.
// The boot guards (requireApiKeyAtBoot, prepareContainerEnvironment) must have
// run first on any server path; if they have not, the fail-closed default
// still applies.
function isApiAuthDisabled(environment = process.env) {
  if (!isApiAuthOptOutSet(environment)) return false;
  const remoteOptIn = isApiAuthRemoteOptInSet(environment);
  const host = resolvedApiAuthHost(environment);
  if (!remoteOptIn && !isLoopbackHost(host)) return false;
  announceApiAuthOptOutOnce({ host, remoteOptIn });
  return true;
}

// Boot-time policy: an opt-out on a non-loopback bind stops the server unless
// the operator added the explicit remote opt-in. Loopback and opt-out-absent
// boots are unaffected. Runs before the listener starts, on the same
// fail-closed footing as the keyless-boot refusal.
function enforceApiAuthOptOutPolicy(environment = process.env) {
  if (!isApiAuthOptOutSet(environment)) return;
  if (isApiAuthRemoteOptInSet(environment)) return;
  const host = resolvedApiAuthHost(environment);
  if (isLoopbackHost(host)) return;
  const error = new Error(
    'HUQAN_DISABLE_API_AUTH serves every API request unauthenticated and is only safe on a loopback bind; '
    + `the configured bind is ${host}. Set HUQAN_DISABLE_API_AUTH_ALLOW_REMOTE=true to accept this explicitly.`,
  );
  error.code = 'HUQAN_API_AUTH_OPT_OUT_UNSAFE';
  throw error;
}

// Doctor finding for the unsafe or opted-in-remote combination. Safe
// deployments get a pass so the finding only surfaces when it matters.
function checkApiAuthOptOut(opts = {}) {
  const environment = opts.environment || process.env;
  if (!isApiAuthOptOutSet(environment)) {
    return { ok: true, detail: 'not set' };
  }
  const host = resolvedApiAuthHost(environment);
  if (isLoopbackHost(host)) {
    return { ok: true, detail: `set; loopback bind ${host}` };
  }
  if (isApiAuthRemoteOptInSet(environment)) {
    return {
      ok: true,
      detail: `set with ALLOW_REMOTE; every API request is served without authentication on bind ${host}`,
    };
  }
  return {
    ok: false,
    detail: `set with non-loopback bind ${host} and no ALLOW_REMOTE; server boot refuses this combination (HUQAN_API_AUTH_OPT_OUT_UNSAFE)`,
  };
}

function resetApiAuthOptOutAnnouncement() {
  apiAuthOptOutAnnounced = false;
}

module.exports = {
  API_AUTH_OPT_OUT_VALUES,
  DEFAULT_SERVER_HOST,
  REMOTE_OPT_IN_VALUES,
  announceApiAuthOptOutOnce,
  checkApiAuthOptOut,
  enforceApiAuthOptOutPolicy,
  isApiAuthDisabled,
  isApiAuthOptOutSet,
  isApiAuthRemoteOptInSet,
  isLoopbackHost,
  resetApiAuthOptOutAnnouncement,
  resolvedApiAuthHost,
};
