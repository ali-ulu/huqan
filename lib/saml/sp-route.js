'use strict';

// SAML 2.0 SP HTTP route (#4214).
//
// Two endpoints:
//   GET  /saml/login   - initiate login; builds an AuthnRequest and 302s the
//     browser to the IdP's SSO URL.
//   POST /saml/acs     - Assertion Consumer Service; validates the signed
//     AuthnResponse, refuses replay, maps the principal, and issues the same
//     short-lived session cookie the API-key login path uses.
//
// The session is the shared one: createSamlSpRoute takes the same sessionStore
// the viewer gateway owns, so a SAML login produces a session indistinguishable
// from an API-key session, and logout/expiry work identically. No parallel
// authorization system.
//
// All trust comes from one place: the administrator-imported IdP metadata.
// There is no runtime fetch of metadata, and the certificate in the response
// must be byte-identical to one in the imported metadata.

const { validateResponse } = require('./assertion');
const { mapSamlPrincipal } = require('./identity-mapping');
const { createSamlReplayStore } = require('./replay-store');
const { buildSetCookie } = require('../viewer/session-cookie');
const { loadSamlSpConfig } = require('./config');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { loadApprovalRbacPolicy } = require('../approval-rbac');
const { decodeSamlResponse } = require('./xml-util');

const ACS_PATH = '/saml/acs';
const LOGIN_PATH = '/saml/login';

function isSamlPath(pathname) {
  return pathname === ACS_PATH || pathname === LOGIN_PATH;
}

/**
 * @returns {{isSamlPath: Function, handle: Function}}
 */
function createSamlSpRoute({
  config,
  sessionStore,
  auditSink,
  now = Date.now,
  replayStore,
  subjectAttribute,
} = {}) {
  if (!config || config.configured !== true || config.ok !== true) {
    throw new TypeError('SAML SP config must be configured and valid');
  }
  if (!sessionStore || typeof sessionStore.create !== 'function') {
    throw new TypeError('sessionStore is required');
  }
  const spConfig = config.config;
  const metadata = spConfig.metadata;
  const replay = replayStore || createSamlReplayStore({ now });
  const acsUrl = spConfig.acsUrl;

  function writeJson(res, status, body, headers = {}) {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    }
    res.end(JSON.stringify(body));
  }

  function audit(eventType, details) {
    if (typeof auditSink === 'function') {
      try {
        auditSink({ eventType, details, actor: 'saml-sp', workspaceId: 'default', timestamp: new Date().toISOString() });
      } catch {
        // Audit failures must not crash the login path.
      }
    }
  }

  function refuse(res, status, code, message) {
    audit('SAML_LOGIN_REFUSED', { code });
    writeJson(res, status, { ok: false, error: { code, message } });
  }

  function readFormBody(req) {
    const chunks = [];
    let size = 0;
    const MAX = 256 * 1024;
    return new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX) {
          reject(new Error('payload_too_large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function formField(body, name) {
    for (const pair of body.split('&')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const key = decodeURIComponent(pair.slice(0, idx));
      if (key === name) return decodeURIComponent(pair.slice(idx + 1));
    }
    return undefined;
  }

  async function handleAcs(req, res) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'ACS accepts POST only' } }, { Allow: 'POST' });
      return true;
    }

    let body;
    try {
      body = await readFormBody(req);
    } catch (error) {
      refuse(res, 413, 'response_too_large', error.message);
      return true;
    }

    const samlResponse = formField(body, 'SAMLResponse');
    const relayState = formField(body, 'RelayState') || '';
    if (typeof samlResponse !== 'string' || samlResponse.length === 0) {
      refuse(res, 400, 'missing_saml_response', 'SAMLResponse form field is required');
      return true;
    }

    // The response is base64-encoded in the HTTP-POST binding. The strict
    // decoder rejects non-canonical padding/truncation and a smuggled UTF-16
    // body (BOM) that would make two XML parsers disagree.
    const decoded = decodeSamlResponse(samlResponse);
    if (!decoded.ok) {
      refuse(res, 400, decoded.code, decoded.message);
      return true;
    }
    const xml = decoded.xml;

    const validated = validateResponse(xml, {
      expectedIssuer: metadata.entityID,
      spEntityId: spConfig.entityId,
      acsUrl,
      trustedCertificates: metadata.x509Cert,
      now: now(),
    });

    if (!validated.ok) {
      refuse(res, 401, validated.code, validated.message);
      return true;
    }

    // Replay: the assertion ID and the InResponseTo (when present) must each
    // be seen at most once.
    const ids = [];
    if (typeof validated.assertionId === 'string' && validated.assertionId) ids.push(validated.assertionId);
    if (typeof validated.inResponseTo === 'string' && validated.inResponseTo) ids.push(validated.inResponseTo);
    for (const id of ids) {
      const claim = replay.consume(id);
      if (!claim.ok) {
        refuse(res, 401, claim.code === 'replayed' ? 'replayed_assertion' : 'malformed_id',
          claim.code === 'replayed' ? 'assertion or request ID already consumed' : 'malformed identifier');
        return true;
      }
    }

    // Identity mapping to shared principal contract.
    const rbacPolicy = loadApprovalRbacPolicy();
    const mapped = mapSamlPrincipal(validated, { subjectAttribute, rbacPolicy });
    if (!mapped.ok) {
      refuse(res, 401, mapped.code, mapped.message);
      return true;
    }

    // RelayState: bounded and opaque. We do not follow it (that would be an
    // open redirect); we return it to the client so the frontend can resume
    // the flow it initiated.
    const relay = relayState && relayState.length <= 8192 ? relayState : '';

    // Issue the shared session (same store as viewer gateway).
    const session = sessionStore.create({
      workspaceId: 'default',
      principal: mapped.principal,
    });
    audit('SAML_LOGIN', {
      operatorId: mapped.principal.operatorId,
      role: mapped.principal.role,
      nameId: mapped.principal.nameId,
    });
    writeJson(res, 200, {
      ok: true,
      expiresAt: session.expiresAt,
      workspaceId: session.workspaceId,
      operatorId: mapped.principal.operatorId,
      role: mapped.principal.role,
      relayState: relay,
    }, {
      'Set-Cookie': buildSetCookie({
        sessionId: session.sessionId,
        secure: true,
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    });
    return true;
  }

  function handleLogin(req, res) {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'login accepts GET only' } }, { Allow: 'GET' });
      return true;
    }
    // 302 to the IdP. The AuthnRequest carries only the correlation ID.
    // For the HTTP-Redirect binding, we encode the minimal AuthnRequest.
    // The IdP signs the response, not the request.
    const sso = metadata.singleSignOnService.find(s => s.binding === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect')
      || metadata.singleSignOnService[0];
    if (!sso || !sso.location) {
      refuse(res, 503, 'no_sso_service', 'no SingleSignOnService location in the IdP metadata');
      return true;
    }
    const requestId = `AR-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const params = new URLSearchParams({
      SAMLRequest: requestId,
      RelayState: '',
    });
    res.writeHead(302, { Location: `${sso.location}?${params.toString()}`, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (pathname === ACS_PATH) return handleAcs(req, res);
    if (pathname === LOGIN_PATH) return handleLogin(req, res);
    return false;
  }

  return { isSamlPath, handle, _replay: replay, _acsPath: ACS_PATH, _loginPath: LOGIN_PATH };
}

// Bootstrap SAML SP from environment and mount the route.
function createSamlSpFromEnv({ sessionStore, auditSink, now = Date.now, readEnvironment = readCompatibleEnvironmentVariable, subjectAttribute } = {}) {
  const config = loadSamlSpConfig({ readEnvironment });
  if (!config.configured || !config.ok) {
    // SAML not configured: return a no-op router.
    return { isSamlPath: () => false, handle: () => false };
  }
  const resolvedSubjectAttribute = subjectAttribute !== undefined
    ? subjectAttribute
    : readEnvironment('SAML_SUBJECT_ATTRIBUTE');
  return createSamlSpRoute({
    config,
    sessionStore,
    auditSink,
    now,
    subjectAttribute: resolvedSubjectAttribute || undefined,
  });
}

module.exports = {
  ACS_PATH,
  LOGIN_PATH,
  isSamlPath,
  createSamlSpRoute,
  createSamlSpFromEnv,
  loadSamlSpConfig,
};
