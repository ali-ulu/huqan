# V3 Core Release Notes

## Summary

This release finalizes the V3 Core smoke and documentation boundary for AXIOM.

V3 Core now covers:

- approval request schema
- pending approval queue
- approve / reject decision flow
- reviewed / blocked action receipts
- memory admission gate
- admission receipts
- audit-compatible decision boundaries

## What Changed

- Added a V3 Core smoke test that wires schema, queue, decision, and memory admission layers together.
- Added a smoke checklist documenting the expected V3 behavior.
- Added release notes documenting the V3 Core boundary and verification scope.

## What Did Not Change

- No server endpoints
- No UI rewrite
- No MCP live certification claim
- No package version bump
- No release tag
- No hidden memory write
- No broad runtime migration
- No V4/V5 implementation

## Known Limitation

Live Codex MCP integration is still pending reinstall.
That is a tooling limitation, not a V3 Core behavior change.

## Next Step

V3.1 MCP Live Integration Recovery

