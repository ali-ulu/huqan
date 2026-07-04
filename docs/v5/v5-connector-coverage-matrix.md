# V5 Connector Coverage Matrix

## Status

Planning only. This matrix records trust boundary status and readiness. It does
not implement connector coverage.

## Coverage Matrix

| Connector path | Trust boundary status | Provenance status | Receipt status | Identity status | Enforcement status | Readiness verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Tested local stdio MCP path | bounded local path | present for tested path | present through V4 surfaces where materialized | implicit local actor/workspace | tested gate/verdict path | planning input only |
| Future HTTP API path | not fully specified | partial through PR3 receipt read API | read-only receipt access exists | not specified | no V5 connector enforcement | blocked pending identity and package contracts |
| Future GitHub App path | not specified | not proven | not proven | not specified | not proven | blocked |
| Future Workbench path | local helper surfaces exist; UI not implemented | helper-derived evidence only | read-only helper evidence | not specified | read-only only | blocked for V5 claims |
| Future external connector path | untrusted by default | not proven | not proven | not specified | not proven | blocked |
| Unsupported / untrusted path | outside trust boundary | absent | absent | absent | fail closed / unsupported | not ready |

## Interpretation

Only the tested local stdio MCP path has green evidence from the V4 chain. That
does not imply arbitrary connector coverage.

Future connector paths must be promoted only through explicit evidence:

- identity contract
- provenance record
- receipt linkage
- connector-specific enforcement test
- no-mock claim boundary

## Promotion Rule

A connector path may move toward readiness only when it has:

- declared trust boundary
- agent identity mapping
- workspace and delegation scope
- receipt and provenance linkage
- enforcement tests
- coverage label
- non-claim statement

## Non-Claims

This matrix does not claim:

- all connector paths are covered
- GitHub App integration is trusted
- HTTP API connector trust is complete
- Workbench UI covers connector trust
- external connectors are marketplace-ready
- V5 implementation is complete
