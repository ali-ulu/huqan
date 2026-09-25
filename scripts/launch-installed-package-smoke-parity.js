'use strict';

const { fail, ok } = require('./launch-installed-package-smoke-context');

function verifyCrossSurfaceReceiptParity(results) {
  const entries = Object.entries(results).filter(([, value]) => value && value.semantics);
  if (entries.length !== 3) {
    fail('cross-surface receipt parity could not run because one or more surface flows failed');
    return;
  }
  const [baselineName, baseline] = entries[0];
  const expected = JSON.stringify(baseline.semantics);
  for (const [name, value] of entries.slice(1)) {
    if (JSON.stringify(value.semantics) !== expected) {
      fail(`receipt semantic mismatch: ${baselineName}=${expected} vs ${name}=${JSON.stringify(value.semantics)}`);
      return;
    }
  }
  ok('CLI / REST / MCP agree on approved receipt decision, status, workspace, policy and canonicality');
}

module.exports = { verifyCrossSurfaceReceiptParity };
