# `huqan protect` — Zero-config protection design

**Status:** Design draft  
**Goal:** One command that puts an existing agent under HUQAN protection with minimal friction.

## Motivation

The current integration path (MCP config or explicit `huqan-gate`) is powerful but still requires the user to understand concepts and edit configuration.  
`huqan protect` aims to reduce that to a single command while remaining honest about what it can and cannot do.

## Desired UX

```bash
npx huqan protect
npx huqan protect --agent claude-code
npx huqan protect --policy strict
npx huqan protect --dry-run
```

Expected outcome:

- Detects the running / configured agent environment
- Wires the appropriate guard (MCP or gate)
- Applies a sensible default policy
- If Approval Authority is installed, prefers service mode
- Prints clear next steps for the operator (how to approve)

## Detection targets (initial)

| Agent / surface          | Detection method                          | Protection method          |
|--------------------------|-------------------------------------------|----------------------------|
| Claude Code / Cursor     | MCP config files, process names           | MCP server registration    |
| OpenCode / Codex / Pi    | Known config paths / CLI flags            | `huqan-gate` wrapper       |
| Generic MCP client       | Existing MCP server list                  | Add `huqan-mcp`            |
| Unknown                  | Fallback to instructions                  | Manual guidance            |

## Default policy (v1)

- Memory writes → `REVIEW`
- High-risk tools (write, delete, exec, network that mutates) → `REVIEW` or `BLOCK`
- Low-risk / read-only tools → `ALLOW`
- When Approval Authority pin is present → prefer service-mode decisions

Policy can later be expressed as a small named preset (`personal`, `strict`, `team`).

## Implementation sketch

Start from what exists: `huqan-gate connect` already detects installed agents
and installs the gate for each (`connectDetectedAgents` in
`lib/external-action-gate-install.js`), and `huqan-gate connect --detect` is
its dry run. `huqan protect` should wrap it, not reimplement detection.

1. **Detect**
   - Look for common MCP config locations
   - Inspect process list / environment for known agents
   - Check for existing `huqan` / `huqan-mcp` / `huqan-gate` presence
   - Check for Approval Authority pin (`authority.json`)

2. **Plan**
   - Decide which integration path to use (MCP vs gate)
   - Decide policy preset
   - Produce a dry-run report of what would change

3. **Apply** (only if not `--dry-run`)
   - Write / update MCP config or install a gate wrapper
   - Ensure operator token exists and is not readable by the model
   - Optionally register pending approvals with the authority

4. **Report**
   - Show current protection status
   - Show how the operator approves (`huqan.approve` / Authority window)
   - Warn about residual risks (agent that never calls the gate is not covered)

## Non-goals (v1)

- Automatically rewriting arbitrary agent source code
- Guaranteeing protection against an agent that deliberately bypasses the gate
- Cross-platform Approval Authority (Windows service first; other OS later)
- Complex multi-policy UI

## Residual risks (must stay visible)

- An agent that never calls HUQAN remains unprotected
- Same-user code can still attempt to edit runtime files or the approval store (ledger makes this detectable)
- `huqan protect` itself runs as the user; it cannot create a stronger boundary than the underlying OS and Authority design allow

## Open questions

- Should `protect` also offer to install the Approval Authority on Windows if missing?
- How aggressive should auto-detection be before falling back to explicit flags?
- Do we want a `huqan unprotect` counterpart from day one?

## Next steps

1. Implement detection for the top 2–3 agent surfaces
2. Ship `--dry-run` first
3. Add the real apply path behind a clear confirmation
4. Document the exact files that will be touched
