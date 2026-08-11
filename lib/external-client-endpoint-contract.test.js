'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID,
  EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION,
  EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
  EXTERNAL_CLIENT_ENDPOINT_METHOD,
  EXTERNAL_CLIENT_ENDPOINT_PATH,
  buildExternalClientEndpointContract,
} = require('./external-client-endpoint-contract');

const EXPECTED_KEYS = Object.freeze([
  'contractVersion',
  'path',
  'method',
  'configKey',
  'configurationState',
  'routeReachable',
  'identityAuthorityReady',
  'workspaceAuthorityReady',
  'freshnessReady',
  'replayProtectionReady',
  'mutationAllowed',
  'receiptWriterReady',
]);

function assertClosed(contract, state) {
  assert.equal(contract.configurationState, state);
  assert.equal(contract.routeReachable, false);
  assert.equal(contract.identityAuthorityReady, false);
  assert.equal(contract.workspaceAuthorityReady, false);
  assert.equal(contract.freshnessReady, false);
  assert.equal(contract.replayProtectionReady, false);
  assert.equal(contract.mutationAllowed, false);
  assert.equal(contract.receiptWriterReady, false);
}

function assertInvalid(value) {
  assert.throws(
    () => buildExternalClientEndpointContract({
      [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: value,
    }),
    (error) => error.code === EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID,
  );
}

test('missing configuration is disabled and every reachability or authority bit stays false', () => {
  const contract = buildExternalClientEndpointContract();

  assert.equal(contract.contractVersion, EXTERNAL_CLIENT_ENDPOINT_CONTRACT_VERSION);
  assert.equal(contract.path, EXTERNAL_CLIENT_ENDPOINT_PATH);
  assert.equal(contract.method, EXTERNAL_CLIENT_ENDPOINT_METHOD);
  assert.equal(contract.configKey, EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV);
  assertClosed(contract, 'disabled');
});

test('zero and false configuration values remain disabled', () => {
  for (const value of [0, false, '0', 'false', ' FALSE ', '']) {
    assertClosed(buildExternalClientEndpointContract({
      [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: value,
    }), 'disabled');
  }
});

test('one and true only request enablement while route, authority, mutation and writer stay closed', () => {
  for (const value of [1, true, '1', 'true', ' TRUE ']) {
    assertClosed(buildExternalClientEndpointContract({
      [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: value,
    }), 'requested');
  }
});

test('legacy endpoint configuration remains compatible and dual values fail closed', () => {
  assertClosed(buildExternalClientEndpointContract({
    AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
  }), 'requested');
  assertClosed(buildExternalClientEndpointContract({
    HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
    AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
  }), 'requested');
  assert.throws(
    () => buildExternalClientEndpointContract({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      AXIOM_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'false',
    }),
    { code: 'HUQAN_ENV_CONFLICT' },
  );
});

test('invalid configuration values fail with the one bounded Endpoint-0 error code', () => {
  for (const value of ['yes', 'enabled', '2', -1, 2, null, {}, []]) {
    assertInvalid(value);
  }
});

test('whitespace and case handling is exact and bounded', () => {
  assertClosed(buildExternalClientEndpointContract({
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: '  TrUe  ',
  }), 'requested');
  assertClosed(buildExternalClientEndpointContract({
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: '  FaLsE  ',
  }), 'disabled');
  assertInvalid(' true now ');
  assertInvalid('01');
});

test('inherited configuration cannot request enablement', () => {
  const inherited = Object.create({
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: '1',
  });

  assert.throws(
    () => buildExternalClientEndpointContract(inherited),
    (error) => error.code === EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID,
  );
});

test('configuration accessors fail closed without invoking attacker-controlled getters', () => {
  let getterCalls = 0;
  const environment = {};
  Object.defineProperty(environment, EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return '1';
    },
  });

  assert.throws(
    () => buildExternalClientEndpointContract(environment),
    (error) => error.code === EXTERNAL_CLIENT_ENDPOINT_CONFIG_INVALID,
  );
  assert.equal(getterCalls, 0);
});

test('symbols and unrelated own keys do not influence the descriptor', () => {
  const marker = Symbol('endpoint-enable');
  const environment = {
    unrelated: '1',
    [marker]: '1',
  };

  const contract = buildExternalClientEndpointContract(environment);
  assertClosed(contract, 'disabled');
});

test('null-prototype configuration is accepted without inherited authority', () => {
  const environment = Object.create(null);
  environment[EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV] = '1';

  assertClosed(buildExternalClientEndpointContract(environment), 'requested');
});

test('descriptor is null-prototype, immutable and limited to the exact approved keys', () => {
  const contract = buildExternalClientEndpointContract({
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: '1',
  });

  assert.equal(Object.getPrototypeOf(contract), null);
  assert.equal(Object.isFrozen(contract), true);
  assert.deepEqual(Object.keys(contract), EXPECTED_KEYS);
  assert.throws(() => { contract.routeReachable = true; }, TypeError);
  assert.equal(contract.routeReachable, false);
  for (const value of Object.values(contract)) {
    assert.notEqual(typeof value, 'function');
    assert.notEqual(typeof value, 'object');
  }
});

test('contract module has no runtime dependencies', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'external-client-endpoint-contract.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /server\.js|kernel\.js|graph\.js|storage|admitExternalPackage|external-client-package-gate/);
});

test('production server remains unaware of the Endpoint-0 route and contract', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.doesNotMatch(serverSource, /\/api\/external-client\/packages\/admit/);
  assert.doesNotMatch(serverSource, /external-client-endpoint-contract/);
  assert.doesNotMatch(serverSource, /external-client-package-gate/);
  assert.doesNotMatch(serverSource, /admitExternalPackage/);
});
