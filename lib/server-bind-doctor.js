'use strict';

// Doctor finding for the server bind (#3900).
//
// server.js binds `HOST || 127.0.0.1`. That default is right for a laptop and
// wrong inside a container, remote host or reverse proxy: the listener is
// reachable only from the loopback interface, the documented web UI and HTTP
// API answer nothing from outside, and `doctor` said nothing about it. The
// operator saw "HUQAN web interface: http://127.0.0.1:3000" and then a 502.
//
// This reports the resolved bind and, when the bind is loopback-only inside a
// container, fails the check: that combination cannot serve the surfaces the
// docs describe, and the fix (HUQAN_HOST=0.0.0.0) is not discoverable from the
// docs. A loopback bind on a bare host stays a pass -- it is the intended
// default -- so the finding only surfaces where it is a real misconfiguration.

const fs = require('fs');
const { isLoopbackHost, resolvedApiAuthHost } = require('./api-auth-opt-out');

const CONTAINER_MARKERS = Object.freeze([
  '/.dockerenv',
  '/run/.containerenv',
  '/run/systemd/container',
]);

const CONTAINER_ENV_MARKERS = Object.freeze([
  'KUBERNETES_SERVICE_HOST',
  'container',
]);

// Docker, Podman and systemd-nspawn each leave a marker file; Kubernetes and
// some runtimes only set an environment variable. A false negative only means
// the operator sees the informational pass instead of the container-specific
// warning, so this stays a cheap best-effort probe.
function detectContainer(environment = process.env, fsProbe = fs) {
  for (const marker of CONTAINER_MARKERS) {
    try {
      if (fsProbe.existsSync(marker)) return true;
    } catch (_) { /* an unreadable marker is not a container signal */ }
  }
  for (const name of CONTAINER_ENV_MARKERS) {
    if (environment[name]) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {object} [opts.environment] defaults to process.env
 * @param {object} [opts.fs] filesystem probe, injected by tests
 * @returns {{ok: boolean, detail: string, host: string, loopback: boolean,
 *            container: boolean}}
 */
function checkServerBind(opts = {}) {
  const environment = opts.environment || process.env;
  const host = resolvedApiAuthHost(environment);
  const loopback = isLoopbackHost(host);
  const container = detectContainer(environment, opts.fs || fs);

  if (container && loopback) {
    return {
      ok: false,
      detail: `listening on ${host}, which is reachable only inside this container; set HUQAN_HOST=0.0.0.0 to serve the UI and API`,
      host,
      loopback,
      container,
    };
  }
  if (container) {
    return { ok: true, detail: `listening on ${host} (container)`, host, loopback, container };
  }
  if (loopback) {
    return { ok: true, detail: `loopback only (${host}); set HUQAN_HOST to bind another interface`, host, loopback, container };
  }
  return { ok: true, detail: `listening on ${host}`, host, loopback, container };
}

module.exports = {
  CONTAINER_ENV_MARKERS,
  CONTAINER_MARKERS,
  checkServerBind,
  detectContainer,
};
