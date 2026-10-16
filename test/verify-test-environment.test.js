'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { verifyTestEnvironment, checkNodeVersion, MIN_NODE } = require('../scripts/verify-test-environment');

describe('verify-test-environment', () => {
  it('accepts the current runtime', () => {
    assert.strictEqual(checkNodeVersion(process.version), null);
  });

  it('rejects Node 20 with an actionable message', () => {
    const error = checkNodeVersion('v20.20.2');
    assert.match(error, /22\.13\.0/);
    assert.match(error, /nvm use/);
  });

  it('reports the pinned minimum', () => {
    assert.strictEqual(MIN_NODE, '22.13.0');
  });

  it('returns no errors on a healthy environment', () => {
    assert.deepStrictEqual(verifyTestEnvironment(), []);
  });
});
