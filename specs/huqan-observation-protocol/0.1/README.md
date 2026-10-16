# HUQAN Observation Protocol 0.1 (draft)

External event producer contract. Any agent/framework sends observations in
this envelope; HUQAN normalizes -> decides -> acts -> observes result -> receipt.

Refs #2446 (bounded contexts incl. Observability), #2388 (adapter correlation + observation coverage).

## Envelope

See `schemas/external-event.schema.json`. Required:

- `schemaVersion`: `huqan.external-event.v1`
- `agent_id`, `run_id`, `step_id`
- `action`: event vocabulary below
- `target`: opaque target descriptor (no raw secrets)
- `input_hash`: SHA-256 hex of the raw input (content stays out)
- `observed_state`: bounded producer-side state summary
- `decision`: producer-known gate hint (`unknown` when none)
- `receipt_id`: set when this event already binds a receipt, else null

## Event vocabulary (initial)

```text
agent.started
agent.planned
tool.requested
tool.approved
tool.blocked
browser.navigated
browser.clicked
shell.requested
shell.executed
memory.proposed
memory.committed
action.failed
action.completed
```

Unknown actions are accepted as `custom/<name>` and must still validate the
envelope. Producers MUST NOT send raw commands, file contents, tokens or PII;
send `input_hash` + bounded `observed_state` instead.

## Non-goals (0.1)

- No transport, no discovery, no marketplace.
- No change to internal `lib/observability/*` runtime paths.
- This spec is additive; internal observability stays authoritative.
