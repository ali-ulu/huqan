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
AGENT_RUNTIME
AGENT_VERSION
API_KEY
BACKUP_DIR
CLI_READ_ROOTS
DB_PATH
DEMO_MODE
DISABLE_AUTO_LISTEN
EXTERNAL_CLIENT_ENDPOINT_ENABLED
HOST
HUMAN_APPROVAL_DISABLED
INGEST_APPROVAL_LEASE_MS
KERNEL_VERSION
LANG
MEMORY_PATH
PARANOID
PLUGIN_PRODUCTION_ENFORCEMENT
PLUGIN_SIGNING_KEY
PLUGIN_STRICT
PORT
RUST_BIN
TRUST_POLICY_ROOTS
TRUST_PROXY
USE_SQLITE
VIEWER_INSECURE_LOOPBACK
```

`HUQAN_PORT` configures the host-side Docker Compose port. The application
inside the container continues to listen on generic `PORT=3000`. Generic
provider and platform variables such as `NODE_ENV`, `OPENAI_API_KEY`, and
`GITHUB_TOKEN` are unchanged.

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
