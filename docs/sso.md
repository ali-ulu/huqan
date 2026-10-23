# OIDC SSO and Corporate Identity (#4204)

**Status: design slice only.** The current server still authenticates protected REST routes with an API key. OIDC login, browser sessions, claim mapping, and OIDC-backed Authority decisions are not implemented by this document. Do not advertise SSO as available until the implementation and provider smoke test pass.

SAML 2.0 is explicitly separate under [#4214](https://github.com/ali-ulu/huqan/issues/4214). It must reuse the principal, session, role-mapping, and Authority assertion contracts below; it must not create a second authorization system.

## Decisions

1. Use the OIDC Authorization Code Flow with PKCE S256. Use the maintained openid-client v6 library for discovery, token exchange, and ID-token validation rather than writing JWT/JWKS validation by hand. The repository requires Node.js >=22.13.0, compatible with the library's current Node runtime requirements. Pin the resolved version in package-lock.json.
2. Configure one exact issuer and registered redirect URI. Require HTTPS for the issuer and production redirect URI. Never accept an issuer, discovery URL, JWKS URL, redirect URI, or callback destination from request parameters. Do not enable insecure-request overrides in production.
3. Generate and bind state, nonce, and a PKCE verifier/challenge for each login. Each transaction is short-lived, single-use, and bound to the initiating browser. The callback fails closed on missing, mismatched, expired, or replayed transaction state.
4. Let the OIDC library validate ID-token signature, issuer, audience/authorized party, expiry, and token response. HUQAN additionally checks the expected nonce, allowed signing algorithms, and configured issuer. UserInfo, if used, must be fetched only from discovered metadata and its subject must equal the validated ID-token subject.
5. Do not treat a browser cookie or a client-supplied operatorId as an Authority identity. The web server must mint a short-lived, signed, action-bound identity assertion after validating the session; the Authority verifies that assertion and its replay protection before applying #4205 RBAC and signing the decision envelope.
6. API-key fallback is off by default when OIDC mode is enabled. A deployment may enable legacy API-key fallback only with an explicit configuration switch and must document which routes accept it.

## Trust boundaries and flow

1. **Login start** (GET /auth/oidc/login): load the configured OIDC client, generate state, nonce, and PKCE, persist a bounded transaction, then redirect to the discovered authorization endpoint.
2. **Callback** (GET /auth/oidc/callback): validate the transaction before token exchange; exchange the code with the stored PKCE verifier; validate the ID token; normalize the principal; create a server-side session; set the session cookie; and redirect only to a preconfigured local path. Never redirect to an arbitrary returnTo URL.
3. **Session** (GET /auth/session): return only the minimum UI identity (operatorId, mapped role, expiry, and CSRF token). Never return the ID token, access token, client secret, session identifier, or private key.
4. **Logout** (POST /auth/logout): require a valid session, same-origin request, and CSRF token; revoke the local session first. RP-initiated IdP logout is optional and may be used only with the discovered end-session endpoint and an encrypted ID-token hint when required by that provider.
5. **Protected REST calls**: denyIfUnauthorized accepts a valid API key or a valid OIDC session only when the configured authentication mode allows that source. Cookie-authenticated state-changing requests require CSRF validation and an exact allowed Origin; SameSite=Lax alone is not the CSRF boundary.
6. **Approval / CLI / MCP**: the browser session is not copied into an operatorId field and is not treated as a CLI credential. The authenticated server or CLI broker creates a signed assertion bound to the exact approval, workspace, tool, action hash, decision, and operator. The Authority validates the signature, audience, short expiry, role permission, and a durable one-time jti before counting a quorum vote.

The Authority-signed decision envelope remains the durable decision record. It contains the normalized operatorId; the identity assertion is input evidence, not a substitute for the Authority's signature or ledger.

## Principal and role mapping

Use a versioned, administrator-owned identity mapping file (default example: config/identity-mapping.example.json). It contains claim names and group-to-role mappings, not provider-specific group names embedded in runtime code. Example:

```json
{
  "version": 1,
  "issuer": "https://idp.example.com/",
  "groupsClaim": "groups",
  "operatorIdStrategy": "issuer-sub-sha256",
  "groupRoles": {
    "huqan-approvers": "approver",
    "huqan-admins": "admin"
  },
  "unmappedGroupPolicy": "deny",
  "roleConflictPolicy": "deny"
}
```

The stable operatorId is derived from the exact validated issuer and the validated OIDC sub claim: hash issuer, a NUL separator, and sub with SHA-256, encode the digest as base64url, and prefix it with oidc:. The subject claim is fixed to sub; it is not configurable, and any configuration attempting to select another subject claim must be rejected. Do not use email as the principal key: it can change and may be reassigned. Group claims are accepted only from the configured claim in the validated ID token/UserInfo response. A missing mapping, unknown role, conflicting role mappings, oversized claims, or unexpected claim type is denied. Never select a role from an unverified request parameter.

The signed identity assertion must carry the normalized operatorId and mapped role. The Authority must verify the assertion before trusting either field and must check that the role exists in the configured #4205 role/permission policy. This requires an explicit #4205 contract extension; until that extension is reviewed and merged, OIDC must not bypass the existing Authority identity gate.

## Session and key storage

- Session identifier: cryptographically random opaque value, at least 256 bits. Store only its hash in a dedicated SQLite session store; do not put sessions in the HUQAN knowledge graph.
- Cookie: __Host-huqan-sso; Secure; HttpOnly; SameSite=Lax; Path=/; no Domain attribute. Production SSO requires HTTPS. Rotate the session identifier after login and privilege changes.
- Session limits: default 30-minute idle timeout and 8-hour absolute lifetime; hard upper bounds in code. Logout revokes the session record. Expired sessions are rejected even if the cookie is still present.
- CSRF: return a per-session CSRF token from the authenticated session endpoint; require it in a custom header for state-changing cookie-authenticated requests and validate the Origin against the configured origin. Do not allow wildcard CORS with credentialed requests.
- Client secret: HUQAN_OIDC_CLIENT_SECRET in the protected service environment. Never store it in the identity-mapping JSON, source control, logs, or browser storage.
- Session encryption key: HUQAN_OIDC_SESSION_ENCRYPTION_KEY_PATH points to a protected key file. If an ID-token hint must be retained for provider logout, encrypt it at rest; do not store access or refresh tokens unless a separately reviewed use case requires them.
- Assertion signing key: HUQAN_OIDC_ASSERTION_PRIVATE_KEY_PATH is available only to the trusted HUQAN identity broker; the Authority receives only the matching public key. The signed assertion must be audience-bound to the Authority, bound to one exact decision, expire within 60 seconds, and contain a unique jti consumed by a durable replay store.
- API-key fallback: HUQAN_OIDC_API_KEY_FALLBACK defaults to disabled in OIDC mode. Enabling it is an explicit migration choice and must be visible in startup diagnostics.

Do not log authorization codes, state, nonce, PKCE verifier, cookies, ID tokens, assertion signatures, session IDs, client secrets, or private keys. Audit events should use stable reason codes and a pseudonymous operatorId, not raw token claims.

## Failure codes

The route contract should return stable codes without exposing token contents or provider response bodies:

| Code | Meaning |
| --- | --- |
| OIDC_NOT_CONFIGURED | Required OIDC settings are absent or contradictory. |
| OIDC_DISCOVERY_FAILED | The configured issuer metadata could not be validated or fetched. |
| OIDC_STATE_INVALID | Missing, expired, mismatched, or replayed login state. |
| OIDC_NONCE_INVALID | The ID token nonce does not match the login transaction. |
| OIDC_PKCE_FAILED | Authorization-code exchange failed PKCE validation. |
| OIDC_TOKEN_INVALID | ID-token signature or required claim validation failed. |
| OIDC_ISSUER_MISMATCH | Token issuer does not equal the configured issuer. |
| OIDC_AUDIENCE_MISMATCH | Token audience/authorized party does not match the registered client. |
| OIDC_CLAIM_MAPPING_DENIED | No unambiguous configured operator/role mapping exists. |
| OIDC_SESSION_EXPIRED | Session is expired, revoked, or unknown. |
| OIDC_CSRF_FAILED | Origin or CSRF-token validation failed. |
| OIDC_ASSERTION_INVALID | Authority identity assertion signature, audience, expiry, or action binding failed. |
| OIDC_ASSERTION_REPLAYED | The assertion jti has already been consumed. |

External errors should be generic 401/403 responses. Detailed diagnostics stay in structured logs with a correlation ID and stable error code; provider bodies and claim values are not logged.

## Implementation slices and gates

1. **Contract slice (this document):** agree on OIDC configuration, session lifecycle, principal mapping, Authority assertion, failure codes, and the explicit SAML boundary.
2. **OIDC RP slice:** add the OIDC library and configuration validation; implement login/callback/logout/session routes and a dedicated session store; cover every protocol rejection with deterministic tests.
3. **Authority identity slice:** extend #4205 to verify the signed, action-bound identity assertion, check role permissions, and durably consume assertion jti values. Preserve the current API-key path only under the explicit fallback switch.
4. **CLI/MCP slice:** use a separate public OIDC client with loopback Authorization Code + PKCE; do not assume every provider supports Device Authorization. Exchange the validated principal for the same short-lived Authority assertion contract.
5. **Provider smoke gate:** document a manual smoke test with one real provider (Entra ID, Okta, Keycloak, Auth0, or Google). Verify that the browser and separate CLI OIDC clients receive the same stable sub for the same person, including the provider's pairwise-subject/sector-identifier configuration where applicable. If the provider cannot guarantee and the smoke test cannot confirm that shared subject, reject cross-client identity use for operator/separation-of-duties decisions; do not infer that two distinct subjects are one person. A mock IdP test is necessary but not a substitute for this gate.

Automated tests must cover successful login/session/logout; invalid issuer, audience, signature, expiry, state, nonce, and PKCE; missing or conflicting group mapping; session expiry/revocation; CSRF and wrong Origin; assertion signature/audience/action mismatch; replayed jti; and explicit API-key fallback behavior. Tests must use a controlled mock IdP and must not require Internet access.

## SAML boundary (#4214)

No SAML routes, XML-signature code, metadata fetch, certificate handling, or SAML dependency belongs in the OIDC implementation slice. #4214 owns the SAML 2.0 Service Provider, trusted metadata import and certificate rollover, assertion/response validation, InResponseTo and RelayState replay protection, and SAML-specific failure codes. Its adapter must normalize validated SAML claims into the same principal/session/role/assertion contract defined here.

## References

- OIDC Core: https://openid.net/specs/openid-connect-core-1_0.html
- OAuth 2.0 Security Best Current Practice: https://www.rfc-editor.org/rfc/rfc9700.html
- openid-client documentation: https://github.com/panva/openid-client
- HUQAN RBAC dependency: https://github.com/ali-ulu/huqan/issues/4205
- Separate SAML scope: https://github.com/ali-ulu/huqan/issues/4214
