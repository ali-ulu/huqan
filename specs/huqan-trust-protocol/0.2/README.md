# HUQAN Trust Protocol 0.2

This directory is the canonical publication surface for the HUQAN V5 JSON
contracts selected by RFC-002. Protocol version `0.2` identifies this
publication lineage; it does not claim that product V5 is complete.

## Published JSON artifacts

The complete publication manifest is:

- `schemas/a2a-trust-evidence.schema.json`
- `schemas/public-trust-receipt.schema.json`
- `schemas/public-receipt-redaction-policy.json`
- `schemas/shared-trust-package.schema.json`
- `schemas/agent-identity.schema.json`

No other file below the repo-internal `schemas/v5/` working directory is public.
In particular, validators, conformance helpers, readiness and coverage code,
and the shared-trust-package conformance matrix are not published.

The files in this manifest are byte-identical to their `schemas/v5/` working
mirrors. A mechanical test rejects missing, different, or undeclared JSON files
in this canonical directory.

## Canonical JSON

`RECEIPT-BUNDLE.md` republishes the existing ATP 0.1 canonical JSON algorithm
without changing or redefining it. The legacy ATP 0.1 tree remains frozen and
available at `specs/axiom-trust-protocol/0.1/`.

Published JSON bytes become immutable after the first package or tagged release
that ships this directory. Contract changes then require a new protocol version.
