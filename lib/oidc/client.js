'use strict';

// OIDC client wrapper (#4267; contract in docs/sso.md).
//
// Discovery, the authorization request, the code exchange and ID-token
// validation all go through openid-client v6. Nothing here parses a JWT or
// fetches a JWKS by hand: the library owns signature, issuer, audience,
// expiry and token-response validation, and the RP only adds the checks the
// library cannot make for it -- the expected nonce, the configured issuer and
// the claim mapping.
//
// This is the only module that touches the openid-client dependency, so a test
// can substitute a client factory and the route never imports the library
// directly. Error classification turns a library error into one stable failure
// code from lib/oidc/failure-codes.js without exposing the provider body.
//
// Discovery is lazy and cached. The server composition root is synchronous and
// must boot with or without a reachable provider; the first login pays for
// discovery, and a failure is reported as OIDC_DISCOVERY_FAILED, fail-closed.

const { OIDC_FAILURE_CODES } = require('./failure-codes');

const ALLOWED_ID_TOKEN_ALGORITHMS = Object.freeze([
  'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512',
]);

function loadOpenidClient() {
  return require('openid-client');
}

/** Collect the messages along an error's `cause` chain, shallowest first. */
function errorMessages(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current.message === 'string') messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * Turn a library error into one stable failure code. The classification reads
 * the message chain because openid-client collapses the underlying
 * oauth4webapi error into a generic top-level message; the specific text
 * ("nonce", "iss", "aud", "state") survives on the cause.
 */
function classifyGrantError(error) {
  const messages = errorMessages(error).join(' | ').toLowerCase();
  if (typeof error?.error === 'string' && error.error === 'invalid_grant') {
    // The token endpoint refused the authorization code. PKCE is the only
    // client-controlled input to that exchange, so OIDC_PKCE_FAILED is the
    // honest code for it.
    return OIDC_FAILURE_CODES.PKCE_FAILED;
  }
  if (messages.includes('nonce')) return OIDC_FAILURE_CODES.NONCE_INVALID;
  if (messages.includes('"iss"') || messages.includes('issuer')) return OIDC_FAILURE_CODES.ISSUER_MISMATCH;
  if (messages.includes('"aud"') || messages.includes('audience') || messages.includes('azp')) {
    return OIDC_FAILURE_CODES.AUDIENCE_MISMATCH;
  }
  if (messages.includes('"state"') || messages.includes('state parameter')) return OIDC_FAILURE_CODES.STATE_INVALID;
  return OIDC_FAILURE_CODES.TOKEN_INVALID;
}

/**
 * Build a client from validated configuration. `deps.client` is a test seam:
 * a test passes a stub and no provider is contacted.
 */
function createOidcClient(config, deps = {}) {
  const client = deps.client || loadOpenidClient();
  const clientAuth = typeof client.ClientSecretBasic === 'function'
    ? client.ClientSecretBasic(config.clientSecret)
    : undefined;

  let discovery = null;
  function discover() {
    if (!discovery) {
      const options = config.allowInsecureRequests ? { execute: [client.allowInsecureRequests] } : undefined;
      discovery = client.discovery(
        new URL(config.issuer),
        config.clientId,
        { client_secret: config.clientSecret },
        clientAuth,
        options,
      ).then((discovered) => {
        // The library validates the signature but accepts any algorithm the
        // provider advertises. HUQAN narrows that: a provider offering only
        // algorithms outside the allowlist (HS*, none) is refused before any
        // token is trusted.
        const supported = discovered?.serverMetadata?.()?.id_token_signing_alg_values_supported;
        if (Array.isArray(supported)
          && !supported.some((alg) => ALLOWED_ID_TOKEN_ALGORITHMS.includes(alg))) {
          const error = new Error('the provider offers no allowed ID-token signing algorithm');
          error.code = OIDC_FAILURE_CODES.DISCOVERY_FAILED;
          throw error;
        }
        return discovered;
      }).catch((error) => {
        discovery = null;
        throw error;
      });
    }
    return discovery;
  }

  return {
    issuer: config.issuer,
    redirectUri: config.redirectUri,

    async calculatePkceChallenge(codeVerifier) {
      return client.calculatePKCECodeChallenge(codeVerifier);
    },

    async buildAuthorizationUrl({ state, nonce, codeChallenge }) {
      const discovered = await discover();
      return client.buildAuthorizationUrl(discovered, {
        redirect_uri: config.redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
    },

    /**
     * Exchange the callback for tokens and validate the ID token. The library
     * checks state, PKCE, signature, issuer, audience and expiry; the expected
     * nonce is checked here because only the RP holds it.
     */
    async exchange(currentUrl, { expectedState, expectedNonce, codeVerifier }) {
      const discovered = await discover();
      const tokens = await client.authorizationCodeGrant(discovered, currentUrl, {
        expectedState,
        expectedNonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) {
        const error = new Error('the token response carried no validated ID token');
        error.code = OIDC_FAILURE_CODES.TOKEN_INVALID;
        throw error;
      }
      return { tokens, claims };
    },
  };
}

module.exports = {
  ALLOWED_ID_TOKEN_ALGORITHMS,
  errorMessages,
  classifyGrantError,
  createOidcClient,
};
