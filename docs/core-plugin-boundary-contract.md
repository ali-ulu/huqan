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
