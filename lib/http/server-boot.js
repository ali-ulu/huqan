'use strict';

// Server boot sequencing: validation first, lifecycle binding second (#2366).
//
// Single responsibility: everything the `require.main` boot path does before
// listening -- refuse a keyless boot, then bind graceful shutdown and process
// failure handling. server.js keeps dependency wiring (what is passed in),
// the listener, and its public facade; this module owns the order. It is
// never a second authority for routing, auth, or request handling.

const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { createGracefulShutdown } = require('./graceful-shutdown');
const { createProcessFailureHandlers, failureCodeFor } = require('./process-failure-handlers');
const { writeStructuredLog } = require('./structured-log');

// Gate A item 6: a server without an API key would boot half-working and fail
// every request at auth instead. Missing startup configuration stops the boot
// here with a specific message. Contradictory configuration is already refused
// earlier by validateEnvironmentCompatibility (HUQAN_ENV_CONFLICT).
function requireApiKeyAtBoot(environment = process.env) {
  if (!readCompatibleEnvironmentVariable('API_KEY', environment)) {
    const error = new Error('HUQAN_API_KEY (or legacy AXIOM_API_KEY) is required to start the server');
    error.code = 'HUQAN_API_KEY_REQUIRED';
    throw error;
  }
}

function createServerLifecycle({ server, closeResources }) {
  if (!server || typeof server.close !== 'function') throw new TypeError('server is required');
  if (typeof closeResources !== 'function') throw new TypeError('closeResources is required');
  const gracefulShutdown = createGracefulShutdown({
    server,
    closeResources,
    logError: (signal, error) => writeStructuredLog(console, 'error', 'http.graceful_shutdown_error', null, {
      signal,
      errorCode: error?.code || 'GRACEFUL_SHUTDOWN_FAILED',
    }),
  });
  const processFailureHandlers = createProcessFailureHandlers({
    logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
      runtime: 'server',
      errorCode: failureCodeFor(kind, cause),
    }),
  });
  function bind() {
    processFailureHandlers.bind();
    gracefulShutdown.bind();
  }
  return Object.freeze({ bind });
}

module.exports = { requireApiKeyAtBoot, createServerLifecycle };
