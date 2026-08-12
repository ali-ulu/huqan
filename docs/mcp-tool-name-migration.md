# HUQAN MCP tool-name migration

`huqan.*` tool names are canonical. The MCP server continues to accept the
matching legacy `axiom.*` name during the compatibility window.

This mirrors the environment-variable migration in
[environment-variable-migration.md](environment-variable-migration.md) and
follows [RFC-001](rfcs/RFC-001-huqan-canonical-naming-and-legacy-compatibility.md)
decision 7: *a reader accepts both; a writer emits only the canonical form.*

## Canonical tools

```text
huqan.learn       huqan.ask         huqan.verify
huqan.plan        huqan.agent       huqan.policy
huqan.approvals   huqan.approve     huqan.reason
huqan.compare     huqan.dream
```

The MCP `serverInfo.name` is `huqan`.

## The rule

- `tools/list` advertises the eleven canonical names **only**. Legacy names are
  never advertised, the same way the environment-variable migration documents
  only `HUQAN_*`.
- `tools/call` accepts either spelling. `axiom.<suffix>` resolves to
  `huqan.<suffix>` and reaches the identical handler, with the identical gate
  decision and the identical result payload.
- A legacy call additionally carries `meta.deprecation` in its response and
  triggers one stderr warning per legacy name per process.
- Only those eleven exact aliases resolve. Any other `axiom.`-prefixed name —
  `axiom.wipe`, `axiom.learn.extra` — is **not** rewritten and is still blocked
  as an unknown tool.
- Approvals are always persisted under the canonical name. Approval rows
  persisted before this change, which carry `tool: "axiom.learn"`, remain
  executable.

Unlike the environment-variable migration there is no dual-configuration case:
a `tools/call` carries exactly one name, so there is nothing for a precedence
rule to arbitrate and no `HUQAN_ENV_CONFLICT` analogue exists here.

## What most installs need to do

Nothing. MCP clients call `tools/list` on connect and use the names it returns,
so Claude Desktop and Cursor pick up the canonical names on the next restart.

Update anything that hardcodes a tool name — scripted MCP clients, saved
prompts, custom agent configurations — by replacing the `axiom.` prefix with
`huqan.`. Nothing breaks if you do not: the legacy names keep working until an
announced breaking compatibility-removal release.

## `meta.deprecation`

A response to a legacy call carries:

```json
{
  "meta": {
    "deprecation": {
      "deprecated": true,
      "rfc": "RFC-001",
      "requestedName": "axiom.ask",
      "canonicalName": "huqan.ask",
      "message": "MCP tool \"axiom.ask\" is a deprecated AXIOM-era alias accepted for compatibility only. Use the canonical name \"huqan.ask\"."
    }
  }
}
```

Every other field of the response is identical to the canonical call's. The
notice is additive.

## Compatibility removal

Per RFC-001's compatibility-removal clause, the `axiom.*` aliases cannot be
removed in a minor or patch release. Removal requires an announced breaking
release, a migration guide published with it, and retained evidence that the
legacy names were accepted up to that point.
