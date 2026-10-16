# RFC-001 — HUQAN Canonical Naming and AXIOM/ATP Legacy Compatibility

**Status:** `ACCEPTED` — contract only. No runtime, wire-format or package
identifier changes in this RFC.

**Gate:** V5-C2 (issue #274)

**Supersedes the framing of:** "ATP to HTP compatibility RFC". The problem this
gate exists to solve is not a protocol rename; see the audit below.

## Summary

`HUQAN` is the canonical product, protocol and namespace identity. `AXIOM` and
`ATP` become **legacy compatibility identifiers only** — still valid, still
readable, never presented as a current, separate product or protocol family.

`HTP` is the abbreviation of `HUQAN Trust Protocol` and nothing else. It is not
a successor protocol to ATP, and no ATP→HTP wire migration is performed or
implied.

This RFC fixes the contract. It changes no code, no wire format and no
identifier. Implementation is split into separately gated work described under
[Migration gates](#migration-gates).

## The naming-value audit that produced this decision

The gate was opened as an ATP→HTP question. Measuring the actual surface showed
that framing was wrong.

### ATP is not where the confusion lives

| Token | Occurrences |
| --- | --- |
| `ATP` | 137 |
| `AXIOM` | 461 |
| `axiom` | 2255 |

The user-visible surface, against an npm package already named `huqan`:

```text
npm package     huqan
env variables   AXIOM_API_KEY, AXIOM_DB_PATH, AXIOM_MEMORY_PATH, … (29 total)
package suffix  .axiom
verifier        packages/axiom-verify
spec paths      specs/axiom-trust-protocol/, specs/axiom-package-format/
```

A user installs `huqan`, sets `AXIOM_API_KEY`, produces `.axiom` artifacts,
validates with `axiom-verify` and reads `specs/axiom-trust-protocol/`. That
mismatch — **AXIOM against HUQAN** — is the real cost. Renaming ATP to HTP
resolves none of it: after such a rename the suffix, the verifier package and all
29 environment variables are unchanged.

### A technical rename solves no compatibility problem

Falsification question: *can an external implementer interoperate fully using the
existing ATP spec, `.axiom` packages and receipt schemas, without ever knowing
the name HTP?*

Answered empirically, not by argument. The clean-room verifier at
`specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py` was written from
`RECEIPT-BUNDLE.md` alone and agrees with the producer on every fixture. It never
needed the protocol's name: no wire field carries one. The bundle envelope is
`schemaVersion` / `workspaceId` / `exportedAt` / `receiptCount` / `bundleHash` /
`receipts`, and receipts declare `v4-receipt-v1`.

So a technical rename buys nothing on the wire. "The roadmap says HTP" is not a
reason.

## Decisions

1. **Canonical product name: `HUQAN`.** `AXIOM` is not used for the product.
2. **Canonical protocol name: `HUQAN Trust Protocol`.**
3. **`HTP` is exactly the abbreviation of `HUQAN Trust Protocol`.** It is not a
   separate or successor protocol family, and introducing it implies no wire
   change. This is stated explicitly because "HUQAN Trust Protocol" abbreviates
   to HTP naturally, and an unstated abbreviation would reopen the question it
   is meant to close.
4. **`ATP 0.1` remains a valid, frozen legacy wire and spec lineage.** Existing
   ATP receipts stay valid indefinitely under the compatibility rules below.
5. **Receipt and bundle `schemaVersion` values never change.** `v4-receipt-v1`,
   `v4-receipt-v2`, `v4-receipt-bundle-v1` and `v4-receipt-bundle-v2` carry no
   product name and are outside this contract.
6. **The package wire format does not change in this gate.** `.axiom`,
   `format: "axiom-package"` and `atpVersion: "0.1"` remain valid and normative.
7. **Legacy identifiers are never used to produce new canonical output** once
   their migration gate lands. A reader accepts both; a writer emits only the
   canonical form.

### Why the package format is excluded here

Unlike receipts, the package format carries the product name **inside the wire
format, as required fields**:

```json
{
  "format": "axiom-package",
  "formatVersion": "0.1",
  "createdBy": "axiom",
  "atpVersion": "0.1"
}
```

`axiom-manifest.schema.json` lists `format`, `formatVersion` and `atpVersion` in
`required`. Emitting `huqan-package` would therefore be a wire-format change that
every validator expecting `axiom-package` rejects, and `atpVersion` is a required
field named after the legacy lineage that can be neither dropped nor renamed
without breaking readers.

That is a migration, not a naming contract, and #274 forbids runtime rename. It
is deferred to its own gate.

## Migration table

| Surface | Canonical | Legacy status | Where |
| --- | --- | --- | --- |
| Product | `HUQAN` | `AXIOM` not used for the product | this RFC |
| Protocol | `HUQAN Trust Protocol` (`HTP`) | `ATP 0.1` frozen valid lineage | this RFC |
| Receipt / bundle `schemaVersion` | unchanged | — | no change ever |
| Environment variables | `HUQAN_*` | `AXIOM_*` accepted | gate M1 |
| MCP tool names | `huqan.*` | `axiom.*` accepted | gate M5 |
| Verifier package | `huqan-verify` | `axiom-verify` compatibility surface | gate M2 |
| Spec paths | `huqan-trust-protocol` | ATP path retained as historical | gate M3 |
| Package suffix | `.huqan` | `.axiom` still read | gate M4 |
| Package format identity | `huqan-package` | `axiom-package` still read | gate M4 |

## Migration gates

Implementation is deliberately **not** one rename PR. Each gate carries its own
backward-compatibility evidence and can be reverted independently.

**M1 — environment variables.** Accept `HUQAN_*`, keep accepting `AXIOM_*`.
Documentation shows only `HUQAN_*`.

Precedence is explicit and fail-closed:

- `HUQAN_X` set → use it.
- only `AXIOM_X` set → accept it as compatibility.
- both set with **different** values → **startup fails**. There is no silent
  precedence.

The consequence must be documented rather than discovered: the process refuses
to start. An operator who adds `HUQAN_API_KEY` beside an existing
`AXIOM_API_KEY` while rotating the value will hit this during the migration
window. Fail-closed is still correct — a silently chosen API key is worse than a
refused start — but the failure must be stated in the migration guide, name the
conflicting variable, and never print either value.

**M2 — verifier package.** `packages/axiom-verify` becomes `huqan-verify`. This
is cheap: it is not separately published, shipping inside the `huqan` tarball, so
no npm name transfer or deprecation pointer is required. The legacy path remains
as a re-export.

**M3 — spec paths.** New canonical path for the HUQAN Trust Protocol spec. The
ATP 0.1 path is retained as historical lineage, not deleted, because published
artifacts reference it.

**M4 — package format.** The largest gate, designed as one unit:

- reader accepts both the legacy and the new format;
- writer emits only the new canonical HUQAN format;
- the new format carries a **new `formatVersion`**. This RFC deliberately does
  not reserve a specific number: whether the change is naming-only or also
  carries corrections is not yet known, and pinning `0.2` here would prejudge
  that;
- `.huqan` suffix, `format: "huqan-package"` and the removal or HUQAN-neutral
  replacement of the ATP-named manifest field are designed together, not
  piecemeal;
- legacy `.axiom` artifacts and `atpVersion`-bearing manifests remain readable.

**M5 — MCP tool names.** Advertise `huqan.*`, keep accepting `axiom.*`.

The original naming-value audit measured environment variables, the package
suffix, the verifier package and the spec paths, and missed the MCP tool
namespace. That omission mattered more than any surface the audit did measure:
the MCP server is the distribution channel a user actually installs, so a user
who installs `huqan` was left typing `axiom.learn` in Claude Desktop or Cursor —
the same `AXIOM`-against-`HUQAN` mismatch, on the most visible surface. This
gate closes it.

Following decision 7 and M1's precedent:

- `tools/list` advertises the canonical `huqan.*` names only, exactly as M1's
  documentation shows only `HUQAN_*`;
- `tools/call` accepts either spelling and resolves both to the same handler,
  with the same gate decision;
- only the eleven declared aliases resolve; any other `axiom.`-prefixed name is
  still blocked as an unknown tool;
- a legacy call carries a `meta.deprecation` notice and one stderr warning per
  name per process;
- approvals are written under the canonical name, and approval rows persisted
  before this gate — which carry `tool: "axiom.learn"` — remain executable.

M1's fail-closed conflict rule has no analogue here: a `tools/call` carries
exactly one name, so there is no dual-configuration case to arbitrate and none
is invented. Migration guide: `docs/mcp-tool-name-migration.md`.

## Compatibility removal

Legacy identifiers cannot be removed in a minor or patch release.

Removal requires all of:

1. an explicitly announced **breaking** compatibility-removal release;
2. a migration guide published with it;
3. reader support for legacy artifacts verified against retained fixtures of the
   old formats, proving the removal did not silently invalidate artifacts that
   were valid before it.

Without a stated end condition a "temporary" alias becomes permanent by default,
which is the failure this contract exists to avoid. Equally, removal without
verified reader support would invalidate artifacts users already hold.

## Compatibility fixtures

Retained as the evidence base for every gate above, and required before any
removal:

- an ATP 0.1 receipt and a receipt bundle in their current form;
- a `.axiom` package carrying `format: "axiom-package"` and `atpVersion: "0.1"`;
- for M1, a configuration exercising each precedence branch, including the
  conflicting-values case that must fail startup.

Existing spec examples under `specs/axiom-trust-protocol/0.1/examples/` and
`specs/axiom-package-format/0.1/examples/` already cover the first two and must
not be regenerated into the new naming when M3 or M4 lands.

## Checkpoint claim

The checkpoint's `"ATP renamed or migrated to HTP"` prohibition is replaced,
because it forbids the wrong thing: it reads as though HTP were a successor
protocol whose adoption is the risk. The actual risk is presenting four
identities at once.

> HTP is not a separate successor protocol to ATP. HUQAN Trust Protocol is the
> canonical current name; ATP 0.1 and AXIOM identifiers remain legacy
> compatibility identifiers until explicitly migrated. Existing ATP receipts and
> AXIOM package artifacts remain valid.

## What this RFC does not do

- No runtime change, no rename, no file moved, no identifier edited.
- No wire-format change. `.axiom`, `format: "axiom-package"` and
  `atpVersion: "0.1"` are untouched and remain normative.
- No `formatVersion` reserved for the future package format.
- No claim that any migration gate is authorized, scheduled or complete.
- No V5 entry claim. `V5_IMPLEMENTATION_ENTRY: FAIL` is unchanged, and its
  blocker remains external interoperability/conformance (#277).

## Outcome

Three identities, one of them current:

```text
HUQAN        the single current identity — product, protocol, namespace
HTP          abbreviation of HUQAN Trust Protocol; not a separate protocol
ATP / AXIOM  legacy compatibility lineage only
```
