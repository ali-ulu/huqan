'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('../lib/viewer/session-store');
const { validateResponse } = require('../lib/saml/assertion');
const { mapSamlPrincipal, REFUSED } = require('../lib/saml/identity-mapping');
const { createSamlReplayStore } = require('../lib/saml/replay-store');
const { loadSamlSpConfig } = require('../lib/saml/config');
const { IDP_ENTITY_ID, SP_ENTITY_ID, ACS_URL, NAME_ID, signFixture, buildResponse } = require('./helpers/saml-fixtures');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeConfig(opts = {}) {
  const metadataFile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-saml-'));
  const { publicKey, privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certPem = publicKey.export({ type: 'spki', format: 'pem' });
  const metadata = {
    entityID: IDP_ENTITY_ID,
    singleSignOnService: [
      { binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', location: 'https://idp.example.test/sso' },
      { binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', location: 'https://idp.example.test/sso' },
    ],
    x509Cert: [certPem],
  };
  fs.writeFileSync(path.join(metadataFile, 'metadata.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(metadataFile, 'private.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return {
    env: {
      HUQAN_SAML_IDP_METADATA_PATH: path.join(metadataFile, 'metadata.json'),
      HUQAN_SAML_SP_ENTITY_ID: SP_ENTITY_ID,
      HUQAN_SAML_SP_ACS_PATH: '/saml/acs',
      HUQAN_SAML_SP_ACS_URL: ACS_URL,
      ...opts,
    },
    cleanup: () => fs.rmSync(metadataFile, { recursive: true, force: true }),
  };
}

function setEnv(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    if (Object.hasOwn(process.env, k)) prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) process.env[k] = v;
    for (const k of Object.keys(env)) if (!Object.hasOwn(prev, k)) delete process.env[k];
  };
}

test('SAML SP config', async (t) => {
  await t.test('loads valid config', () => {
    const { env, cleanup } = makeConfig();
    const restore = setEnv(env);
    try {
      const cfg = loadSamlSpConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.ok, true);
      assert.equal(cfg.config.entityId, SP_ENTITY_ID);
      assert.equal(cfg.config.metadata.entityID, IDP_ENTITY_ID);
    } finally {
      restore();
      cleanup();
    }
  });

  await t.test('fails without metadata path', () => {
    const restore = setEnv({ HUQAN_SAML_SP_ENTITY_ID: SP_ENTITY_ID, HUQAN_SAML_SP_ACS_PATH: '/saml/acs' });
    try {
      const cfg = loadSamlSpConfig();
      assert.equal(cfg.configured, false);
      assert.equal(cfg.ok, true);
    } finally {
      restore();
    }
  });

  await t.test('fails with unreadable metadata', () => {
    const restore = setEnv({
      HUQAN_SAML_IDP_METADATA_PATH: '/nonexistent/path.json',
      HUQAN_SAML_SP_ENTITY_ID: SP_ENTITY_ID,
      HUQAN_SAML_SP_ACS_PATH: '/saml/acs',
    });
    try {
      const cfg = loadSamlSpConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.ok, false);
      assert.match(cfg.reason, /unreadable/);
    } finally {
      restore();
    }
  });

  await t.test('fails with missing entityID in metadata', () => {
    const metadataFile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-saml-'));
    const { publicKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = publicKey.export({ type: 'spki', format: 'pem' });
    const metadata = {
      singleSignOnService: [{ binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', location: 'https://idp.example.test/sso' }],
      x509Cert: [certPem],
    };
    fs.writeFileSync(path.join(metadataFile, 'metadata.json'), JSON.stringify(metadata));
    const restore = setEnv({
      HUQAN_SAML_IDP_METADATA_PATH: path.join(metadataFile, 'metadata.json'),
      HUQAN_SAML_SP_ENTITY_ID: SP_ENTITY_ID,
      HUQAN_SAML_SP_ACS_PATH: '/saml/acs',
    });
    try {
      const cfg = loadSamlSpConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.ok, false);
      assert.match(cfg.reason, /entityID/);
    } finally {
      restore();
      fs.rmSync(metadataFile, { recursive: true, force: true });
    }
  });

  await t.test('fails without SP entity ID', () => {
    const metadataFile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-saml-'));
    const { publicKey, privateKey } = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = publicKey.export({ type: 'spki', format: 'pem' });
    const metadata = {
      entityID: IDP_ENTITY_ID,
      singleSignOnService: [{ binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', location: 'https://idp.example.test/sso' }],
      x509Cert: [certPem],
    };
    fs.writeFileSync(path.join(metadataFile, 'metadata.json'), JSON.stringify(metadata));
    const restore = setEnv({
      HUQAN_SAML_IDP_METADATA_PATH: path.join(metadataFile, 'metadata.json'),
      HUQAN_SAML_SP_ENTITY_ID: '',
      HUQAN_SAML_SP_ACS_PATH: '/saml/acs',
    });
    try {
      const cfg = loadSamlSpConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.ok, false);
      assert.match(cfg.reason, /Entity ID/);
    } finally {
      restore();
      fs.rmSync(metadataFile, { recursive: true, force: true });
    }
  });
});

test('SAML validateResponse', async (t) => {
  await t.test('valid response passes', () => {
    const { signed, certPem } = signFixture();
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, true);
    assert.equal(result.issuer, IDP_ENTITY_ID);
    assert.equal(result.subject.nameId, NAME_ID);
  });

  await t.test('rejects invalid signature', () => {
    const { signed, certPem } = signFixture();
    const tampered = signed.replace('>operator-1<', '>mallory<');
    const result = validateResponse(tampered, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    // Signature invalid is the expected code
    assert.ok(result.code.includes('signature'));
  });

  await t.test('rejects mismatched issuer', () => {
    const { signed, certPem } = signFixture({ issuer: 'https://evil.example.com' });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'issuer_mismatch');
  });

  await t.test('rejects wrong audience', () => {
    const { signed, certPem } = signFixture({ audience: 'https://other-sp.example.com' });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'audience_mismatch');
  });

  await t.test('rejects wrong destination', () => {
    const { signed, certPem } = signFixture();
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: 'https://wrong.example.com/saml/acs',
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'destination_mismatch');
  });

  await t.test('rejects expired assertion', () => {
    const { signed, certPem } = signFixture({
      notBefore: '2020-10-23T00:00:00.000Z',
      notOnOrAfter: '2020-10-23T00:30:00.000Z',
    });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.ok(result.code.includes('assertion'));
  });

  await t.test('rejects request correlation mismatch', () => {
    const { signed, certPem } = signFixture({ inResponseTo: 'different-request-id' });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
      expectedInResponseTo: 'expected-request-id',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'request_correlation_mismatch');
  });

  await t.test('rejects missing subject confirmation', () => {
    const { signed, certPem } = signFixture({ confirmationMethod: '' });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.ok(result.code.includes('subject_confirmation') || result.code.includes('confirmation'));
  });

  await t.test('rejects recipient mismatch', () => {
    const { signed, certPem } = signFixture({ recipient: 'https://wrong.example.com/saml/acs' });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.ok(result.code.includes('recipient') || result.code.includes('mismatch'));
  });

  await t.test('rejects unbounded assertion window', () => {
    const { signed, certPem } = signFixture({
      notBefore: '2026-10-23T00:00:00.000Z',
      notOnOrAfter: '2027-10-23T00:00:00.000Z', // > 24h
    });
    const result = validateResponse(signed, {
      expectedIssuer: IDP_ENTITY_ID,
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      trustedCertificates: [certPem],
    });
    assert.equal(result.ok, false);
    assert.ok(result.code.includes('assertion') || result.code.includes('window'));
  });
});

test('SAML identity mapping', async (t) => {
  await t.test('maps NameID to operatorId when no subject attribute', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'operator-1': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'operator-1' }, attributes: {} };
    const result = mapSamlPrincipal(validated, { rbacPolicy: cfg });
    assert.equal(result.ok, true);
    assert.equal(result.principal.operatorId, 'operator-1');
  });

  await t.test('maps configured subject attribute to operatorId', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'operator-1@example.com': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'ignored' }, attributes: { email: ['operator-1@example.com'] } };
    const result = mapSamlPrincipal(validated, { subjectAttribute: 'email', rbacPolicy: cfg });
    assert.equal(result.ok, true);
    assert.equal(result.principal.operatorId, 'operator-1@example.com');
  });

  await t.test('rejects multi-value subject attribute', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'a@example.com': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'ignored' }, attributes: { email: ['a@example.com', 'b@example.com'] } };
    const result = mapSamlPrincipal(validated, { subjectAttribute: 'email', rbacPolicy: cfg });
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSED.MULTIVALUE_ATTRIBUTE);
  });

  await t.test('rejects missing subject attribute', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'operator-1': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'ignored' }, attributes: {} };
    const result = mapSamlPrincipal(validated, { subjectAttribute: 'email', rbacPolicy: cfg });
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSED.UNBOUND_SUBJECT);
  });

  await t.test('rejects unbound NameID', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'operator-1': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'https://idp.example.com/user/123' }, attributes: {} };
    const result = mapSamlPrincipal(validated, { rbacPolicy: cfg });
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSED.UNBOUND_SUBJECT);
  });

  await t.test('rejects unknown operator in RBAC policy', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'known-op': 'approver' }, roles: { approver: ['approvals.view', 'approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'unknown-op' }, attributes: {} };
    const result = mapSamlPrincipal(validated, { rbacPolicy: cfg });
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSED.UNKNOWN_OPERATOR);
  });

  await t.test('rejects operator with no view permission', () => {
    const cfg = { configured: true, ok: true, policy: { operators: { 'operator-1': 'custom' }, roles: { custom: ['approvals.decide'] } } };
    const validated = { ok: true, issuer: IDP_ENTITY_ID, subject: { nameId: 'operator-1' }, attributes: {} };
    const result = mapSamlPrincipal(validated, { rbacPolicy: cfg });
    assert.equal(result.ok, false);
    assert.equal(result.code, REFUSED.ROLE_NOT_CONFIGURED);
  });
});

test('SAML replay store', async (t) => {
  await t.test('consumes unique IDs', () => {
    const store = createSamlReplayStore();
    assert.deepEqual(store.consume('id-1'), { ok: true });
    assert.deepEqual(store.consume('id-2'), { ok: true });
  });

  await t.test('rejects replayed ID', () => {
    const store = createSamlReplayStore();
    assert.deepEqual(store.consume('id-1'), { ok: true });
    assert.deepEqual(store.consume('id-1'), { ok: false, code: 'replayed' });
  });

  await t.test('rejects malformed ID', () => {
    const store = createSamlReplayStore();
    assert.deepEqual(store.consume(''), { ok: false, code: 'malformed_id' });
    assert.deepEqual(store.consume('a'.repeat(200)), { ok: false, code: 'malformed_id' });
    assert.deepEqual(store.consume('bad/id'), { ok: false, code: 'malformed_id' });
  });

  await t.test('evicts expired entries', () => {
    let now = 1000;
    const store = createSamlReplayStore({ now: () => now, maxLookbackMs: 100 });
    assert.deepEqual(store.consume('id-1'), { ok: true });
    now = 1200; // 200ms later, entry expired
    assert.deepEqual(store.consume('id-1'), { ok: true }); // can consume again after expiry
  });
});

test('SAML SP route integration', async (t) => {
  await t.test('loads route when configured', () => {
    const { env, cleanup } = makeConfig({ HUQAN_SAML_SP_ACS_URL: ACS_URL });
    const restore = setEnv(env);
    try {
      const sessionStore = createSessionStore();
      const { createSamlSpFromEnv } = require('../lib/saml/sp-route');
      const route = createSamlSpFromEnv({ sessionStore });
      assert.equal(typeof route.handle, 'function');
      assert.equal(route.isSamlPath('/saml/acs'), true);
      assert.equal(route.isSamlPath('/saml/login'), true);
      assert.equal(route.isSamlPath('/viewer/session'), false);
    } finally {
      restore();
      cleanup();
    }
  });

  await t.test('returns no-op when not configured', () => {
    const restore = setEnv({ HUQAN_SAML_SP_ENTITY_ID: undefined });
    try {
      const sessionStore = createSessionStore();
      const { createSamlSpFromEnv } = require('../lib/saml/sp-route');
      const route = createSamlSpFromEnv({ sessionStore });
      assert.equal(typeof route.handle, 'function');
      assert.equal(route.isSamlPath('/saml/acs'), false);
    } finally {
      restore();
    }
  });
});

function setEnv(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    if (Object.hasOwn(process.env, k)) prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) process.env[k] = v;
    for (const k of Object.keys(env)) if (!Object.hasOwn(prev, k)) delete process.env[k];
  };
}