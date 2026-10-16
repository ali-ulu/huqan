'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createExternalClientProductionBoundary,
} = require('./external-client-production-boundary');
const { stableStringify } = require('./receipt/canonical-receipt');
const { EXTERNAL_CLIENT_TRUST_CONFIG_VERSION } = require('./external-client-trust-config');

const graph = Object.freeze({});

function environment(values = {}) {
  return Object.assign(Object.create(null), values);
}

function configurationError(callback) {
  assert.throws(callback, (error) => (
    error?.code === 'EXTERNAL_CLIENT_PRODUCTION_CONFIG_INVALID'
    && error.message === 'external client production configuration is invalid'
  ));
}

function validProfile() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  return stableStringify({
    profileVersion: EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
    expectedIdentitySubject: 'connector:boundary-test',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-boundary',
    expectedPackageId: 'pkg.boundary',
    permissions: ['package:admit'],
    trustedKeys: {
      'boundary-key': {
        publicKeySpkiDer: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        workspaceId: 'workspace-boundary', packageIds: ['pkg.boundary'],
        identitySubjects: ['connector:boundary-test'], identityKinds: ['connector'],
        notBefore: new Date(now - 60000).toISOString(), notAfter: new Date(now + 60000).toISOString(), revoked: false,
      },
    },
  });
}

function createLinkOrSkip(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); }
  catch (error) { t.skip(`symbolic link unavailable: ${error.code}`); return false; }
  return true;
}

test('production boundary stays absent when disabled or requested without a server-owned profile', () => {
  assert.equal(createExternalClientProductionBoundary({ graph, environment: environment() }), null);
  assert.equal(createExternalClientProductionBoundary({
    graph,
    environment: environment({ HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true' }),
  }), null);
});

test('partial or malformed external-client production configuration fails before a route can exist', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d8-boundary-'));
  const profilePath = path.join(directory, 'profile.json');
  const replayPath = path.join(directory, 'replay.sqlite');
  fs.writeFileSync(profilePath, '{}', 'utf8');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: profilePath,
    }),
  }));
  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: replayPath,
    }),
  }));
  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: profilePath,
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: replayPath,
    }),
  }));
});

test('boundary source is server-only composition with no request-owned identity or profile bytes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'external-client-production-boundary.js'), 'utf8');
  assert.match(source, /materializeExternalClientTrustConfig/);
  assert.match(source, /createExternalClientReplayStore/);
  assert.match(source, /commitExternalClientCandidateClaim/);
  assert.doesNotMatch(source, /req\.(?:headers|body|url)/);
});

test('profile parent junction is rejected before the production boundary can exist', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d8-profile-link-'));
  const trustedDirectory = path.join(directory, 'trusted');
  const linkedDirectory = path.join(directory, 'linked');
  fs.mkdirSync(trustedDirectory);
  fs.writeFileSync(path.join(trustedDirectory, 'profile.json'), validProfile(), 'utf8');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (!createLinkOrSkip(t, trustedDirectory, linkedDirectory, 'junction')) return;
  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: path.join(linkedDirectory, 'profile.json'),
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: path.join(directory, 'replay.sqlite'),
    }),
  }));
});

test('profile leaf symlink is rejected without reading or altering its target', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d8-profile-leaf-'));
  const targetPath = path.join(directory, 'target.json');
  const profilePath = path.join(directory, 'profile.json');
  fs.writeFileSync(targetPath, 'untouched', 'utf8');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (!createLinkOrSkip(t, targetPath, profilePath, 'file')) return;
  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: profilePath,
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: path.join(directory, 'replay.sqlite'),
    }),
  }));
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'untouched');
});

test('replay database leaf symlink is rejected without altering its target', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d8-replay-link-'));
  const profilePath = path.join(directory, 'profile.json');
  const targetPath = path.join(directory, 'target.sqlite');
  const replayPath = path.join(directory, 'replay.sqlite');
  fs.writeFileSync(profilePath, validProfile(), 'utf8');
  fs.writeFileSync(targetPath, 'untouched', 'utf8');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (!createLinkOrSkip(t, targetPath, replayPath, 'file')) return;
  configurationError(() => createExternalClientProductionBoundary({
    graph,
    environment: environment({
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: profilePath,
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: replayPath,
    }),
  }));
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'untouched');
});
