# Core / Plugin Boundary Contract

## Principle

Core provides trust mechanics.
Plugins provide domain behavior.

This contract defines where AXIOM core stops and where HUQAN-style plugins start.
The boundary exists to keep trust logic centralized and domain logic isolated.

## Core Responsibilities

Core owns the trust machinery and must remain the source of truth for:

- graph contract
- provenance
- audit trail
- workspace isolation
- memory admission
- action gate
- approval workflow
- Trust Receipt
- deterministic `verify.status` contract
- plugin loading and capability gating
- fail-closed behavior for unknown tools

Core may coordinate execution, but it must not absorb domain-specific parsing or plugin-specific policy logic.

## Plugin Responsibilities

Plugins provide domain behavior and may define:

- domain extraction
- Turkish relation extraction
- legal parser behavior
- aviation rule behavior
- enterprise policy packs
- repo-memory behavior
- company-brain behavior
- specialized workflow or enrichment logic

A plugin can interpret its domain, but it must still hand results back through core trust mechanics.

## Boundary Rule

Plugins must not bypass the core trust boundary.

A plugin may propose facts, relations, labels, or candidates, but it must not:

- write canonical graph state directly without kernel/admission
- bypass provenance
- bypass audit
- bypass workspace isolation
- bypass memory admission
- bypass the action gate
- redefine `verify.status`
- mutate storage internals directly
- silently trust unsupported LLM output
- silently convert weak extraction into verified truth

If a plugin cannot satisfy the boundary, the result must fail closed or remain non-canonical.

## Enforcement Boundary: Signed Is Not Sandboxed

The Boundary Rule above is a **contract**, not a runtime confinement.

`plugin.js` loads every plugin with `require(filePath)`. A loaded plugin is
ordinary in-process Node code: it shares the process with the kernel and holds
the same privileges the host process holds — `fs`, `child_process`, `net`,
`https`, `process.env`, and direct access to kernel internals. Nothing in the
loader restricts what a plugin may call.

What plugin verification actually proves:

| Verification status | Proves | Does **not** prove |
| --- | --- | --- |
| `unverified` | nothing | — |
| `verified` (hash) | the file matches its adjacent manifest `sha256` | that the file is safe, or that the manifest was not rewritten alongside it |
| `verified-signed` | the hash is HMAC-signed with the deployment's signing key | anything about plugin *behavior* |

So: **a signature attests authenticity and integrity, never confinement.** A
correctly signed plugin can still call `require('child_process')`, read secrets
out of `process.env`, or write graph state without going through admission.
Signing answers "is this the code the operator approved?", not "is this code
allowed to do that?".

### Operational consequence

Installing a plugin is equivalent to granting that code full host privileges.
Treat the plugins directory as a **trusted code path**: only place plugins there
that you would be willing to run as a direct `node` script on the same machine,
and review plugin source with the same care as core source. Filesystem write
access to the plugins directory is, by construction, code execution — the
manifest hash raises the bar for silent tampering only, since an attacker who
can rewrite the plugin can rewrite the manifest beside it.

### Why there is no sandbox

Node's `vm` module is explicitly **not** a security mechanism (see the "vm —
Executing JavaScript" section of the Node.js documentation). Code inside a `vm`
context reaches the host realm through ordinary prototype access, for example
`this.constructor.constructor('return process')()`. Wrapping the loader in `vm`
would therefore not confine a hostile plugin; it would advertise a guarantee
this project cannot keep, which is worse than a documented status quo.

Real confinement needs an OS- or runtime-level boundary — a separate process
with dropped privileges, a container, or a WASM isolate with an explicit
host-call surface — and is a product decision with a real cost, not a loader
tweak. Until such a boundary exists, this section is the honest statement of
where the trust boundary sits (#362).

A future `permissions` manifest field gating plugin `require()` calls would be
defense-in-depth and an audit aid — a declared, reviewable capability list — but
it would remain bypassable from in-process code, and must not be described as a
sandbox either.

## Verify Status Contract

`verify.status` remains a core contract, not a plugin-specific invention.

The allowed status semantics are controlled by core, including the current deterministic contract for:

- supported / grounded claims
- contradiction detection
- unknown or unsupported claims
- risk / review conditions

Plugins may supply evidence or domain signals, but they may not redefine the meaning of `verify.status`.

If a plugin needs a domain-specific verdict shape, it must map that shape into core-supported status and metadata without changing the underlying contract.

## Relation Extraction Rule

Relation extraction belongs to plugins when it is domain behavior.

Core may consume extracted relations, but core must not become the parser or relation-extraction engine.

The rule is:

- plugin extracts or proposes domain relations
- core admits, audits, and persists only through trust mechanics
- extraction cannot become canonical unless it passes the core boundary

If relation extraction is uncertain, incomplete, or domain-specific, it stays in plugin space until admitted.

## Examples

### repo-memory

`repo-memory` may extract or enrich repository knowledge, but any canonical graph write still goes through core admission, provenance, and audit.

### company-brain

`company-brain` may search or rank repository knowledge and return evidence, but it must not bypass the trust boundary when surfacing canonical decisions.

### future legal plugin

A future legal plugin may parse legal clauses or obligations, but it must still route outputs through core verify, admission, provenance, and audit rules.

### future aviation plugin

A future aviation plugin may model domain terms and safety language, but it must still respect the same trust boundary and fail-closed requirements.

## Non-Goals

This contract does not:

- move domain logic into core
- add parser complexity to core
- permit plugin-side admission bypass
- change the `verify.status` contract
- rewrite relation extraction
- define a new product surface
- add runtime behavior by itself
- replace implementation work

This document is an architecture contract, not a feature implementation.
