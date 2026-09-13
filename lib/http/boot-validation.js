'use strict';

// Boot-time startup validation for the HTTP server, Production Gate A
// item 6 (#2366).
//
// Single responsibility: refuse to boot when required startup configuration
// is missing, with a specific message and code. A server without an API key
// would otherwise boot half-working and fail every request at auth instead.
// Contradictory configuration is already refused earlier by
// validateEnvironmentCompatibility (HUQAN_ENV_CONFLICT); this module only
// covers absence. Callers: server.js boot path. Never imported for its side
// effects -- it has none.

const { readCompatibleEnvironmentVariable } = require('../environment-compat');

function requireApiKeyAtBoot(environment = process.env) {
  if (!readCompatibleEnvironmentVariable('API_KEY', environment)) {
    const error = new Error('HUQAN_API_KEY (or legacy AXIOM_API_KEY) is required to start the server');
    error.code = 'HUQAN_API_KEY_REQUIRED';
    throw error;
  }
}

module.exports = { requireApiKeyAtBoot };
