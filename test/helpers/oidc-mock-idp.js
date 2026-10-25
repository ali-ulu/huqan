'use strict';

// A controlled OIDC provider for the RP tests (#4267). No Internet access: the
// discovery document, the JWKS and the token endpoint are served by a loopback
// HTTP server started per test, and the ID token is signed with a key this file
// generates. The RP's only insecure-loopback exception is what lets the test
// point it at http://127.0.0.1.

const http = require('node:http');
const crypto = require('node:crypto');

const KID = 'huqan-test-key-1';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function createSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = KID;
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  return { jwk, privateKey };
}

function signJwt(payload, { privateKey, alg = 'RS256' }) {
  const header = b64url(JSON.stringify({ alg, kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Start a mock provider. `claimsFor(request)` returns the ID-token payload for a
 * token request, so a test can vary the nonce, issuer, audience or groups.
 */
async function startMockIdp({ claimsFor, tokenStatus = 200, tokenBody } = {}) {
  const key = createSigningKey();
  let issuer = 'http://127.0.0.1:0';
  const codes = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }));
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [key.jwk] }));
      return;
    }
    if (url.pathname === '/token') {
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenBody || { error: 'invalid_grant' }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        const entry = codes.get(params.get('code'));
        if (!entry) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const claims = claimsFor(entry);
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(
          { iss: issuer, aud: entry.clientId, iat: now, exp: now + 300, ...claims },
          { privateKey: key.privateKey },
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  server.issuer = issuer;

  return {
    issuer,
    server,
    /** The authorization request the RP built, parsed. */
    registerAuthorizationUrl(location) {
      const url = new URL(location);
      return {
        state: url.searchParams.get('state'),
        nonce: url.searchParams.get('nonce'),
        codeChallenge: url.searchParams.get('code_challenge'),
        codeChallengeMethod: url.searchParams.get('code_challenge_method'),
        redirectUri: url.searchParams.get('redirect_uri'),
      };
    },
    /** Mint an authorization code the token endpoint will accept. */
    issueCode({ clientId, nonce, sub = 'user-1', groups = ['huqan-approvers'], issuerOverride }) {
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { clientId, nonce, sub, groups, issuerOverride });
      return code;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startMockIdp, signJwt, createSigningKey, KID, b64url };
