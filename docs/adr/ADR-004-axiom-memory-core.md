# ADR-004 - AXIOM Memory Core

Status: Accepted

## Context

AXIOM v0.9 finalizes the Semantic Trust Gate. The next architectural step is to add durable memory to AXIOM.

## Decision

AXIOM will implement a first-class "Memory Core" inside the product.

### Why Memory Core comes before Self-Healer
Memory Core must be implemented before Self-Healer. Self-Healer requires memory history, repeated patterns, and reviewed fixes to function safely. Self-Healer cannot make informed decisions without a foundational, durable, and auditable memory structure to query past bugs and resolutions.

### Why StackMemory is absorbed as AXIOM Memory Core, not separate MCP
StackMemory is a powerful concept, but it will be absorbed directly into AXIOM as the AXIOM Memory Core rather than remaining a separate app or a separate MCP server. A separate MCP or database product would fragment state and bypass AXIOM's Trust Kernel. By absorbing it, Memory Core remains deeply integrated with AXIOM's trust, reasoning, and provenance layers, acting as a unified source of truth for the CLI, API, MCP surface, plugins, and the Self-Healer.

## Core Deterministic Capabilities (APIs)
The Memory Core must support deterministic memory APIs:
- `storeMemory`
- `searchMemories`
- `listMemories`
- `queryMemories`
- `linkMemories`
- `getMemoryGraph`
- `timeQuery` (sm_time_query)
- `batchMemoryOperations`
- `patchMemoryMetadata`
- `tombstoneMemory`
- `supersedeMemory`

## Core Rules

### Immutable Memory Content Rule
Memory content is strictly immutable. We do not overwrite memory content. Any updates or changes to a memory must use `supersedeMemory()`, which creates a new memory and a supersedes link. Deletions must use `tombstoneMemory()`. Metadata can be updated via `patchMemoryMetadata()`.

### Provenance / Trust / Audit Integration
Memory must not bypass the Trust Kernel. Memory content must remain attributable and provenance-aware, aligning with the `.axiom` exchange format and trust policy versioning (`trust_policy_version`). All reads and writes must be fully auditable through AXIOM's provenance mechanisms.

### Workspace Boundaries
Memory is strictly scoped to a workspace. It respects workspace boundaries to ensure isolation between different contexts and projects.

## Future Plugin Split
AI-generated memory summaries, conceptual clustering, and digests should remain optional. They will be implemented as a future plugin split for summary / cluster / digest, rather than being mandatory core features. 

## Later Schema PR Plan
No schema implementation is included in this ADR. A later PR will introduce the SQL-backed schema migration (Postgres-ready) and actual API endpoints. 

## Consequences

- AXIOM can remember without becoming a separate memory product.
- Memory behavior remains deterministic, immutable, and auditable.
- Memory powers all AXIOM surfaces without fragmenting state.
- Establishes a safe foundation before building Self-Healer.
