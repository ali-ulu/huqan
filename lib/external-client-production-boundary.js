'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readCompatibleEnvironmentVariable,
} = require('./environment-compat');
const {
  EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV,
  buildExternalClientEndpointContract,
} = require('./external-client-endpoint-contract');
const {
  materializeExternalClientTrustConfig,
} = require('./external-client-trust-config');
const {
  createExternalClientReplayStore,
} = require('./external-client-replay-store');
const { createHuqanClient } = require('./sdk');
const {
  commitExternalClientCandidateClaim,
} = require('./external-client-mutation-receipt-owner');
const {
  createExternalClientHttpAdapter,
} = require('./external-client-http-adapter');
const { stableStringify } = require('./receipt/canonical-receipt');

const EXTERNAL_CLIENT_TRUST_PROFILE_PATH = 'EXTERNAL_CLIENT_TRUST_PROFILE_PATH';
const EXTERNAL_CLIENT_REPLAY_DB_PATH = 'EXTERNAL_CLIENT_REPLAY_DB_PATH';
const MAX_PROFILE_BYTES = 1024 * 1024;
const ROOT_KEYS = Object.freeze([
  'profileVersion', 'expectedIdentitySubject', 'expectedIdentityKind',
  'expectedWorkspaceId', 'expectedPackageId', 'permissions', 'trustedKeys',
]);
const KEY_KEYS = Object.freeze([
  'publicKeySpkiDer', 'workspaceId', 'packageIds', 'identitySubjects',
  'identityKinds', 'notBefore', 'notAfter', 'revoked',
]);

function fail() {
  const error = new Error('external client production configuration is invalid');
  error.code = 'EXTERNAL_CLIENT_PRODUCTION_CONFIG_INVALID';
  throw error;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => (
    typeof key === 'string' && expected.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
  ));
}

function assertTrustedAbsolutePath(target, allowMissingLeaf = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail();
  const parsed = path.parse(target);
  const parts = path.relative(parsed.root, target).split(/[\\/]+/).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return;
      fail();
    }
    if (stat.isSymbolicLink()) fail();
  }
}

function readProfileFile(profilePath) {
  assertTrustedAbsolutePath(profilePath);
  let stat;
  let bytes;
  try {
    stat = fs.statSync(profilePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PROFILE_BYTES) fail();
    bytes = fs.readFileSync(profilePath);
  } catch (error) {
    if (error?.code === 'EXTERNAL_CLIENT_PRODUCTION_CONFIG_INVALID') throw error;
    fail();
  }
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    if (stableStringify(parsed) !== text) fail();
  } catch (error) {
    if (error?.code === 'EXTERNAL_CLIENT_PRODUCTION_CONFIG_INVALID') throw error;
    fail();
  }
  if (!exactKeys(parsed, ROOT_KEYS) || !exactKeys(parsed.trustedKeys, Object.keys(parsed.trustedKeys))) fail();
  const trustedKeys = Object.create(null);
  for (const keyId of Object.keys(parsed.trustedKeys)) {
    const record = parsed.trustedKeys[keyId];
    if (!keyId || keyId.trim() !== keyId || !exactKeys(record, KEY_KEYS)
      || typeof record.publicKeySpkiDer !== 'string'
      || !/^[A-Za-z0-9+/]{59}=$/.test(record.publicKeySpkiDer)) fail();
    const der = Buffer.from(record.publicKeySpkiDer, 'base64');
    if (der.length !== 44 || der.toString('base64') !== record.publicKeySpkiDer) fail();
    trustedKeys[keyId] = { ...record, publicKeySpkiDer: der };
  }
  return { ...parsed, trustedKeys };
}

function endpointContract(environment) {
  const enabled = readCompatibleEnvironmentVariable('EXTERNAL_CLIENT_ENDPOINT_ENABLED', environment);
  return buildExternalClientEndpointContract(Object.assign(Object.create(null), {
    [EXTERNAL_CLIENT_ENDPOINT_ENABLE_ENV]: enabled,
  }));
}

function createExternalClientProductionBoundary(options = {}) {
  if (!options || typeof options !== 'object' || !options.graph) fail();
  const environment = options.environment || process.env;
  const contract = endpointContract(environment);
  if (contract.configurationState === 'disabled') return null;

  const profilePath = readCompatibleEnvironmentVariable(EXTERNAL_CLIENT_TRUST_PROFILE_PATH, environment);
  const replayPath = readCompatibleEnvironmentVariable(EXTERNAL_CLIENT_REPLAY_DB_PATH, environment);
  if (profilePath === undefined && replayPath === undefined) return null;
  if (profilePath === undefined || replayPath === undefined) fail();
  assertTrustedAbsolutePath(replayPath, true);

  const profile = materializeExternalClientTrustConfig(readProfileFile(profilePath));
  let replayStore;
  try {
    replayStore = createExternalClientReplayStore({ dbPath: replayPath });
    assertTrustedAbsolutePath(replayPath);
    const client = createHuqanClient(null, {
      ...profile,
      clock: () => Date.now(),
      replayStore,
      packageAdmissionHandler: (pkg, context) => (
        commitExternalClientCandidateClaim(pkg, context, {
          graph: options.graph,
          ...(Object.hasOwn(options, 'agentIdentityRuntime')
            ? { agentIdentityRuntime: options.agentIdentityRuntime }
            : {}),
        })
      ),
    });
    const adapter = createExternalClientHttpAdapter({
      admitPackage: (input) => client.admitExternalPackage({
        identity: {
          subject: profile.expectedIdentitySubject,
          kind: profile.expectedIdentityKind,
        },
        workspaceId: profile.expectedWorkspaceId,
        package: input.package,
        signature: input.signature,
      }),
    });
    return Object.freeze({
      path: contract.path,
      method: contract.method,
      handle: adapter.handle,
      close: () => replayStore.close(),
    });
  } catch (error) {
    try { replayStore?.close(); } catch (_) {}
    if (error?.code === 'EXTERNAL_CLIENT_PRODUCTION_CONFIG_INVALID') throw error;
    fail();
  }
}

module.exports = Object.freeze({
  EXTERNAL_CLIENT_TRUST_PROFILE_PATH,
  EXTERNAL_CLIENT_REPLAY_DB_PATH,
  createExternalClientProductionBoundary,
});
