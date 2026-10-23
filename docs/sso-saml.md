# SAML 2.0 Service Provider — HUQAN SSO

## Overview

HUQAN provides a minimal, fail-closed SAML 2.0 Service Provider (SP) for operator login. The SP is activated only when administrator-imported IdP metadata is present and `SAML_SP_ENTITY_ID` is configured. No runtime metadata fetch is performed; trust is anchored to a JSON file supplied out-of-band.

Supported flows:
- SP-initiated AuthnRequest via `GET /saml/login`
- IdP POST binding to ACS at configured `SAML_SP_ACS_PATH` (default `/saml/acs`)

## Configuration

Environment variables
- `SAML_IDP_METADATA_PATH` — Path to JSON IdP metadata file. Required fields: `entityID`, `singleSignOnService`, `x509Cert`. Optional: `singleLogoutService`.
- `SAML_SP_ENTITY_ID` — Absolute URL for the SP entity ID. Required when SAML is enabled.
- `SAML_SP_ACS_PATH` — Internal ACS path, defaults to `/saml/acs`.
- `SAML_SP_ACS_URL` — Optional explicit public ACS URL for reverse-proxy deployments.

Metadata JSON shape:
```json
{
  "entityID": "https://idp.example.com",
  "singleSignOnService": "https://idp.example.com/sso/saml",
  "x509Cert": "MIID...",
  "singleLogoutService": "https://idp.example.com/slo"
}
```

Config loading is in `lib/saml/config.js`. Missing fields, unreadable file, or absent entity ID return explicit errors; the SP is considered not configured rather than partially usable.

## Security properties

All validation is fail-closed. Every check returns a distinct `code` that maps to audit entries.

### Response validation
`lib/saml/assertion.js` performs:
- Non-empty XML, size ≤256 KiB
- SAML Version 2.0
- Response Destination matches `acsUrl`
- `InResponseTo` correlation to SP-issued request ID
- Status = Success
- Exactly one Assertion, Assertion Version 2.0
- Signature verification via `lib/saml/signature.js` (xml-crypto, W3C C14N + XML-DSig). Accepts Response-signed or Assertion-signed. Trust anchors are certificates extracted from the imported metadata; no dynamic fetch.
- Issuer equals IdP `entityID`
- Conditions time window: `NotBefore`/`NotOnOrAfter` with 5 min clock skew, max 24 h window, not yet valid/expired rejected
- Audience contains SP Entity ID
- Subject present with NameID, Bearer `SubjectConfirmation`
- `SubjectConfirmationData` Recipient matches ACS URL, time window valid
- `AuthnStatement` present, session not expired
- Attributes bounded and normalized; attribute name ≤256, values ≤64 per attribute, each ≤4 KiB

### Replay and CSRF protection
`lib/saml/replay-store.js` stores consumed Assertion IDs in memory with TTL sweep. Duplicate ID, malformed ID, or evicted entries are rejected.

RelayState is bound to the request ID: the SP issues a random `_samlRequestId` stored in server session; ACS verifies the response `InResponseTo` matches. RelayState value itself is not trusted for authentication.

### Identity mapping
`lib/saml/identity-mapping.js` maps SAML NameID or configured subject attribute to HUQAN operator ID. Multi-value subject attributes are rejected. Unknown operators are rejected against the RBAC policy contract. Mapping is read-only; no attribute-driven privilege escalation is performed.

### Session integration
`lib/saml/sp-route.js` handles `/saml/login` and ACS. After successful validation, `mapSamlPrincipal` produces a principal, then a viewer session is created via the existing session store. Audit entries are emitted for success and each failure code.

## Threat model additions

The SP introduces the following STRIDE considerations:

**Spoofing**
- Forged Assertion: mitigated by signature verification against imported IdP certs, issuer check, audience check, destination/recipient check.
- Replay: mitigated by replay store with unique ID consumption.

**Tampering**
- Assertion swap / signature wrapping: mitigated by XML-DSig verification with canonicalization and assertion-signed acceptance.
- Metadata tampering: mitigated by admin-controlled metadata file; config load fails closed on missing fields.

**Information disclosure**
- Assertion leakage via logs: response XML is not logged; only IDs and codes are audited.

**Elevation of privilege**
- Attribute injection: attributes are bounded and never grant privileges, only map to existing RBAC principals.

**Denial of service**
- Large responses rejected >256 KiB.
- Replay store sweep prevents unbounded growth.

## Failure codes

Codes returned by `validateResponse`:
- `malformed_response`, `response_too_large`
- `unsupported_version`
- `destination_mismatch`
- `request_correlation_mismatch`, `unexpected_in_response_to`
- `status_not_success`
- `missing_assertion`, `too_many_assertions`
- `no_trusted_certificates`
- `signature_*` (from signature module)
- `issuer_mismatch`
- `malformed_conditions`, `assertion_not_yet_valid`, `assertion_expired`, `assertion_window_unbounded`
- `audience_mismatch`
- `missing_subject`, `missing_name_id`, `missing_subject_confirmation`, `recipient_mismatch`, `malformed_confirmation`, `confirmation_outside_window`
- `missing_authn_statement`, `session_expired`
- `attribute_malformed`

## Testing

Tests in `test/saml-sp.test.js` cover:
- Config loading errors
- Valid response passes
- Invalid signature, issuer, audience, destination
- Expired assertion
- Request correlation mismatch
- Missing subject confirmation
- Recipient mismatch
- Unbounded assertion window
- Replay store consume/reject/evict
- Identity mapping NameID fallback and attribute mapping
- RBAC rejection for unknown operator / no permission

All fixtures are controlled signed SAML responses generated with a test IdP key pair. No network calls are made.

## Operational notes

- Clock skew is 5 minutes; ensure server time is synchronized.
- Rotate IdP metadata by replacing the JSON file and reloading the process.
- For IdP-initiated login, the SP accepts responses without `InResponseTo` only if `expectedInResponseTo` is not set; operator policy should prefer SP-initiated.
- SAML logout is not implemented in this release.

## References

- SAML 2.0 Core, OASIS
- `lib/saml/*`
- `test/saml-sp.test.js`
