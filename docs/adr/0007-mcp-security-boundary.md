# ADR 0007: MCP is a security boundary

## Status
Accepted

## Context
The MCP server exposes HUQAN capabilities to external model/tool clients. Allowing MCP handlers to reach kernel mutation internals directly would make a transport surface a privileged back door around action policy, admission, provenance, and audit controls.

## Decision
The MCP server is an external security boundary. MCP tool calls that can read privileged state or cause effects are normalized into the gate/admission contracts and pass through the MCP gate adapter and the applicable downstream policy before execution. MCP handlers do not obtain direct privileged kernel access as an alternative path around those controls.

Transport concerns remain in the MCP layer; policy decisions remain in the gate/admission layer; canonical domain mutations remain in their owning runtime. Tool verdicts and provenance are propagated so the resulting action is auditable.

## Consequences
- MCP cannot become an ungoverned shortcut into canonical state.
- Tool additions require explicit policy/gate integration.
- The same trust rules can be reused across transports.
- Boundary tests should fail when a handler bypasses the adapter or directly invokes privileged mutation internals.

## References
- `mcpServer.js`
- `lib/mcp-gate-adapter.js`
- `lib/memory-admission-gate.js`
- `docs/adr/ADR-010-production-external-client-boundary.md`
- Issue #2640 (A4)
