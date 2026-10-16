# External-client production boundary

Only `POST /api/external-client/packages/admit` can admit the one configured
external client. It is disabled by default.

Enable it only with all three server environment variables:

```text
HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED=true
HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH=/absolute/path/profile.json
HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH=/absolute/path/replay.db
```

The `AXIOM_` aliases are compatibility inputs, not separate settings. Supplying
both spellings with different values fails startup. When enabled with neither
path, the route remains a generic `404`. Supplying exactly one path is partial
configuration and fails before the HTTP listener starts, as do non-absolute,
unreadable, non-canonical, malformed, or unsafe profile/replay configurations.

The profile is canonical UTF-8 JSON with exactly one client identity,
workspace, package ID, `package:admit` permission, and one or two active
Ed25519 public-key records. Each `publicKeySpkiDer` is standard base64 for the
44-byte Ed25519 SPKI DER public key. Private keys, API keys, clocks, mutation
handlers, trusted-key selection, workspace selection, and replay paths are not
HTTP inputs and must never appear in this file.

The request body remains exactly `{ "package": ..., "signature": ... }`.
The generic API key is an outer transport guard only; it does not establish the
external identity or trust root. A success means the server-owned Authority-0
check, durable SQLite replay reservation, bounded quarantine candidate mutation,
and canonical mutation receipt completed. A repeated signed package is rejected
before a second mutation.

Non-claims: this route does not enforce GitHub, Markdown, CLI, MCP, workflow,
or arbitrary SDK connectors; it does not provide a multi-client registry,
dynamic key provisioning, public deployment, or automatic retry after an
unknown mutation outcome.

The profile path and every existing parent component, plus the replay database
path before and after creation, must not be symbolic links or Windows junctions.
This fail-closed check assumes the configured directories are controlled by the
server operator; it does not claim atomic safety against a hostile local process
or administrator replacing filesystem components between checks and SQLite open.
