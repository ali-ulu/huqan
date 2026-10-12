# HUQAN environment-variable migration

`HUQAN_*` names are canonical. The runtime continues to accept the matching
legacy `AXIOM_*` name during the compatibility window.

For every supported suffix the rule is exact:

- only `HUQAN_X` is set: use it;
- only legacy `AXIOM_X` is set: preserve the existing behavior;
- both are set to the same raw value: use that value;
- both are set to different raw values: refuse startup with
  `HUQAN_ENV_CONFLICT`.

The conflict error names both variables and never includes either value. Empty
strings count as set values; comparison does not trim or normalize secrets.

## Supported suffixes

```text
A2A_AUTHORITY_FILE
A2A_REPLAY_DIR
AGENT_RUNTIME
AGENT_VERSION
API_KEY
BACKUP_DIR
CLI_READ_ROOTS
COLLECTOR_SEAL_KEY
COLLECTOR_SEAL_KEY_ID
DB_PATH
DEMO_MODE
DISABLE_API_AUTH
DISABLE_API_AUTH_ALLOW_REMOTE
DISABLE_AUTO_LISTEN
EXPERIENCE_ENABLED
EXTERNAL_CLIENT_ENDPOINT_ENABLED
EXTERNAL_CLIENT_REPLAY_DB_PATH
EXTERNAL_CLIENT_TRUST_PROFILE_PATH
GATE_AURA_SIGNALS
GITHUB_APP_BETA_ENABLED
GITHUB_APP_HOST
GITHUB_APP_ID
GITHUB_APP_PORT
GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_APP_STORE_PATH
GITHUB_APP_STREAMING_TRUST_ENABLED
GITHUB_APP_WEBHOOK_SECRET
GITHUB_TOKEN
HEADERS_TIMEOUT_MS
HOST
HUMAN_APPROVAL_DISABLED
INGEST_ALLOWED_ROOTS
INGEST_APPROVAL_LEASE_MS
ISSUER_SEAL_KEY
KEEP_ALIVE_TIMEOUT_MS
KERNEL_VERSION
LANG
LLM_PROXY_API_KEY
LLM_PROXY_TIMEOUT_MS
LLM_PROXY_UPSTREAM
MAX_CONCURRENT_REQUESTS
MAX_QUEUE_DEPTH
MCP_APPROVAL_TTL_MS
MCP_CAPABILITY_NONCE_DIR
MCP_LEGACY_VERIFY_STATUS
MCP_OPERATOR_TOKEN
MEMORY_PATH
NOTIFY_WEBHOOK_SECRET
NOTIFY_WEBHOOK_URL
OBSERVABILITY_AUTHZ_POLICY
PARANOID
PLUGIN_PRODUCTION_ENFORCEMENT
PLUGIN_SIGNING_KEY
PLUGIN_STRICT
PORT
RECEIPT_COLLECTOR_ROOT
RECEIPT_REQUIRE_SIGNATURE
RECEIPT_TRUSTED_KEYS
REGISTRY_DIR
REQUEST_TIMEOUT_MS
RUN_KNOWN_FAILING_REGRESSIONS
RUST_BIN
SUPPLY_CHAIN_ACTIVATION_POLICY
TRUST_POLICY_ROOTS
TRUST_PROXY
USE_SQLITE
VIEWER_INSECURE_LOOPBACK
```

The list above mirrors `ENVIRONMENT_SUFFIXES` in `lib/environment-compat.js`
(sorted, deduplicated). A suffix not on this list is rejected with
`HUQAN_ENV_SUFFIX_UNKNOWN`.

`HUQAN_KERNEL_VERSION` and `HUQAN_AGENT_VERSION` are no longer runtime
switches. KernelV2 and AgentV3 are the canonical runtimes; `kernel.js` and
`agent.js` remain only as the internal implementations they wrap. Both
variables are still read so that a stale deployment fails fast rather than
silently running a different engine: the canonical values (`v2` and `v3`) are
accepted, and any other value refuses startup with
`HUQAN_KERNEL_VERSION_UNSUPPORTED` or `HUQAN_AGENT_VERSION_UNSUPPORTED`.
Remove them from your configuration; they select nothing.

`HUQAN_AGENT_RUNTIME` is unaffected — it chooses between the agent loop and
the workflow runtime, not between two versions of the same agent.

`HUQAN_PORT` configures the host-side Docker Compose port. The application
inside the container continues to listen on generic `PORT=3000`. Generic
provider and platform variables such as `NODE_ENV` and `OPENAI_API_KEY` are
unchanged.

`HUQAN_GITHUB_TOKEN` is not a generic passthrough: the GitHub connector reads
it through the compatibility shim, so the legacy `AXIOM_GITHUB_TOKEN`
fallback and the `HUQAN_ENV_CONFLICT` check apply to it like any other
supported suffix.

The gate hook's opt-in AURA signal producer is off by default. Passing
`--aura-signals` or setting `HUQAN_GATE_AURA_SIGNALS` to a truthy value
(`1`, `true`, `on`, `yes`) loads the external AURA plugin as a bounded signal
provider; without either, the egress gate path is unchanged. The flag is also
read through the compatibility shim, so `AXIOM_GATE_AURA_SIGNALS` is accepted
as the legacy spelling and a conflicting dual configuration refuses startup.

## Safe rollout

1. Copy each existing legacy value to its canonical name without changing it.
2. Restart and confirm the process accepts the equal dual configuration.
3. Remove the legacy name and restart again.
4. Rotate secrets only after the legacy name has been removed.

Do not add a new canonical API key while simultaneously rotating the legacy
key. Different dual values intentionally cause an outage rather than silently
selecting one credential. If startup reports `HUQAN_ENV_CONFLICT`, restore the
two named variables to the same value or remove one of them; the error output
does not reveal either value.

Docker and Compose follow the same rule. Container defaults are applied only
when neither spelling is present, so an existing legacy-only deployment keeps
working. New examples and deployment configuration should use canonical names.

## MemoryStore persistence when SQLite is disabled

When `HUQAN_USE_SQLITE=false` (or the compatible `AXIOM_USE_SQLITE=false`) is set, the managed MemoryStore uses JSON persistence whenever a memory path is configured. A direct `MemoryStore` receives that path through `memoryPath`; the Kernel keeps the graph’s `MEMORY_PATH` separate and derives a sibling `<stem>.memory-store.json` file for managed memories unless an explicit `memoryStorePath` is supplied. This prevents the graph JSON and managed-memory JSON from overwriting one another.

The JSON file contains memory records, append-only memory events, and memory links. Store, metadata patch, tombstone, supersede, and package-import mutations are persisted atomically, and reload validates records plus their event/link memory references before applying them. `save()` and `load()` report `backend: "json"`, `persistent: true`; `save()` is an actual write (`skipped: false`). If SQLite is disabled without a configured memory path, the MemoryStore remains process-local and `save()` fails closed with `PERSISTENCE_DISABLED` rather than claiming durability.

This setting does not change the existing fail-closed behavior when SQLite is explicitly requested but its driver is unavailable.

---

> This documents the runtime behavior of the current source. It is not a deployment or external interoperability claim.
