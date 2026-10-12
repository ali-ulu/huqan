'use strict';

// The closed file set the approval authority service runs (#3860).
//
// The Windows installer copies exactly these files into a directory the
// interactive user cannot write, and the service runs them from there. Running
// them from the user's checkout would let any same-user agent edit the code
// that holds the operator secret, which is the gap this service closes.
// test/authority-bundle-closure.test.js keeps the set closed: listed files and
// allowed node: builtins only, checked statically and by loading the bundle.

const AUTHORITY_BUNDLE_FILES = Object.freeze([
  'lib/authority/approval-registration.js',
  'lib/authority/approval-view.js',
  'lib/authority/authority-pin.js',
  'lib/authority/authority-service.js',
  'lib/authority/bundle-manifest.js',
  'lib/authority/consumption-envelope.js',
  'lib/authority/decision-envelope.js',
  'lib/authority/http-server.js',
  'lib/authority/keys.js',
  'lib/authority/ledger-store.js',
  'lib/authority/operator-check.js',
  'lib/authority/sealed-request.js',
  'lib/authority/service-main.js',
  'lib/authority/state-store.js',
  'lib/authority/totp.js',
  'lib/hash-chain.js',
  'lib/mcp-operator-capability.js',
]);

// Builtins that load or run other code (module, vm, child_process,
// worker_threads) are deliberately absent: through them the service could
// reach outside the protected directory.
const ALLOWED_BUILTINS = Object.freeze(['buffer', 'crypto', 'events', 'fs', 'http', 'os', 'path', 'url', 'util']);

module.exports = { AUTHORITY_BUNDLE_FILES, ALLOWED_BUILTINS };
