'use strict';

// Preload (`node -r`) that makes the LICENSE-ENTERPRISE paths unresolvable, the
// way a core-only deployment without those files would see them.

const Module = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BLOCKED = ['saml', 'oidc', 'siem', 'evidence-pack'].map((dir) => path.join(ROOT, 'lib', dir) + path.sep);
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveWithoutEnterprise(request, ...rest) {
  const resolved = resolveFilename.call(this, request, ...rest);
  if (BLOCKED.some((dir) => resolved.startsWith(dir))) {
    const error = new Error(`Cannot find module '${request}'`);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return resolved;
};
