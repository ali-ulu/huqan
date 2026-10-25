'use strict';

// The stable failure codes the OIDC RP route contract answers with (#4267,
// table in docs/sso.md). They are constants rather than string literals so a
// route and its test cannot drift apart, and so an audit reader can enumerate
// every refusal this slice can produce.

const OIDC_FAILURE_CODES = Object.freeze({
  NOT_CONFIGURED: 'OIDC_NOT_CONFIGURED',
  DISCOVERY_FAILED: 'OIDC_DISCOVERY_FAILED',
  STATE_INVALID: 'OIDC_STATE_INVALID',
  NONCE_INVALID: 'OIDC_NONCE_INVALID',
  PKCE_FAILED: 'OIDC_PKCE_FAILED',
  TOKEN_INVALID: 'OIDC_TOKEN_INVALID',
  ISSUER_MISMATCH: 'OIDC_ISSUER_MISMATCH',
  AUDIENCE_MISMATCH: 'OIDC_AUDIENCE_MISMATCH',
  CLAIM_MAPPING_DENIED: 'OIDC_CLAIM_MAPPING_DENIED',
  SESSION_EXPIRED: 'OIDC_SESSION_EXPIRED',
  CSRF_FAILED: 'OIDC_CSRF_FAILED',
});

module.exports = { OIDC_FAILURE_CODES };
