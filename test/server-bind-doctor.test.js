'use strict';

// #3900: `doctor` must report the listener bind and flag the one combination
// that silently breaks the documented UI/API -- a loopback bind inside a
// container. These drive the real check with an injected environment and
// filesystem probe, so the container/loopback branches are observed, not
// assumed.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkServerBind,
  detectContainer,
} = require('../lib/server-bind-doctor');

function fsWith(markers) {
  return { existsSync: (target) => markers.includes(target) };
}

const NO_MARKERS = fsWith([]);
const DOCKER = fsWith(['/.dockerenv']);

test('detectContainer sees a Docker marker file', () => {
  assert.equal(detectContainer({}, DOCKER), true);
});

test('detectContainer sees the Kubernetes service host without a marker file', () => {
  assert.equal(detectContainer({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, NO_MARKERS), true);
});

test('detectContainer is false on a bare host', () => {
  assert.equal(detectContainer({}, NO_MARKERS), false);
});

test('a loopback bind inside a container fails the check and names the fix', () => {
  const result = checkServerBind({ environment: {}, fs: DOCKER });

  assert.equal(result.ok, false);
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.loopback, true);
  assert.equal(result.container, true);
  assert.match(result.detail, /HUQAN_HOST=0\.0\.0\.0/);
});

test('an explicit non-loopback bind inside a container passes', () => {
  const result = checkServerBind({ environment: { HUQAN_HOST: '0.0.0.0' }, fs: DOCKER });

  assert.equal(result.ok, true);
  assert.equal(result.host, '0.0.0.0');
  assert.equal(result.loopback, false);
});

test('a loopback bind on a bare host stays the intended default and passes', () => {
  const result = checkServerBind({ environment: {}, fs: NO_MARKERS });

  assert.equal(result.ok, true);
  assert.equal(result.host, '127.0.0.1');
  assert.match(result.detail, /loopback only/);
  assert.match(result.detail, /HUQAN_HOST/);
});

test('the legacy AXIOM_HOST spelling resolves the bind', () => {
  const result = checkServerBind({ environment: { AXIOM_HOST: '0.0.0.0' }, fs: DOCKER });

  assert.equal(result.host, '0.0.0.0');
  assert.equal(result.ok, true);
});
