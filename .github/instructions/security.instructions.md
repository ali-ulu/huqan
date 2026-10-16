---
applyTo: "lib/**/*.js"
---

# HUQAN security-sensitive implementation guidance

When changing files under `lib/`, assume trust, authority, provenance, persistence,
approval, workspace, and external-action boundaries may be security relevant.

- Preserve fail-closed behavior for malformed, unknown, or unauthorized input.
- Never allow the proposing model/agent to satisfy its own approval requirement.
- Do not bypass receipt, provenance, workspace, identity, or capability checks for convenience.
- Preserve canonical JavaScript semantics when touching accelerated or alternate execution paths.
- Treat plugin authenticity and plugin sandboxing as different properties; do not claim signatures sandbox code.
- Prefer explicit denial over silent fallback at privilege boundaries.
- Add or update a negative-path test when changing a gate or authority decision.
- Do not weaken a security invariant merely to make an existing test pass.
- Read `SECURITY.md`, `THREAT_MODEL.md`, `AGENTS.md`, and the relevant contract before changing a security boundary.
