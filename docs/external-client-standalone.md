# Standalone external-client proof

This proof client uses only Node.js standard-library modules and talks to the
existing test harness over real loopback HTTP. It does not import HUQAN code.

```text
node scripts/external-client.js admit --url http://127.0.0.1:<port>/api/external-client/packages/admit --api-key <key> --input request.json --output response.json
accepted: <receipt-id>

node scripts/external-client.js verify --receipt receipt-artifact.json --response response.json --package package.json --identity-subject connector:route-test --identity-kind connector --workspace workspace-route-a --package-id pkg.route.workspace-a
verified: <receipt-id>
```

`request.json` must contain the exact signed envelope (`package` and
`signature`). Identity and workspace authority remain server-owned. The
integration test supplies a valid Ed25519 package scoped to one identity and
workspace. The test host exports the actual durable receipt record and its
canonical payload as `receipt-artifact.json`; this is a test export, not a
production endpoint. The standalone verifier independently recomputes the
package hash and chained receipt hash, then binds identity, workspace, package,
operation, candidate, decision, verdict, status, and returned receipt IDs.
Tampered signatures, unknown keys, package-hash changes, workspace mismatches,
and identity mismatches exit non-zero, create no output artifact, and create no
mutation. An identical replay leaves the operation ID, receipt ID, receipt hash,
and row counts unchanged. The CLI accepts only the documented input/output
arguments and creates (never overwrites) its response output.

Nonclaims: this is not production route wiring, third-party interoperability,
remote deployment, key provisioning, or general SDK support. The production
server route remains intentionally unregistered.
