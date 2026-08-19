# HTTP Upload Approval Contract

`POST /upload` and its compatibility alias `POST /yukle` are authenticated, review-only HTTP boundaries. They accept a document proposal, run the memory admission gate, and never write to the graph without an authorized approval path.

## Non-queued behavior

The upload boundary currently does **not** persist an approval candidate. A review-only upload therefore returns HTTP `200` with `ok: true`, `learned: 0`, and an admission whose transport-level `approvalStatus` is `not_queued`.

```json
{
  "ok": true,
  "learned": 0,
  "admission": {
    "outcome": "review",
    "approvalStatus": "not_queued",
    "graphWrite": false,
    "receipt": {
      "approvalId": "",
      "approvalStatus": "pending"
    }
  }
}
```

The distinction is intentional. `admission.approvalStatus` describes what the HTTP caller can do next: there is no persisted approval row to resolve. The immutable receipt keeps its `pending` decision state because it records that the proposed memory write was not approved, not that a queue item exists.

The response must never claim that a caller-controlled `approvalStatus`, `approvalId`, `approvalRequired`, or admission-bypass field can authorize a write. The authenticated HTTP actor is derived by the server as `http-api`, and graph counts remain unchanged for this review-only path.

## Queued ingest is a separate surface

Clients that need a durable approval lifecycle must use `POST /api/ingest`. That surface persists a real `http.ingest` approval, returns an approval ID, exposes unresolved approvals through `/api/ingest/approvals`, and supports an operator-only decision route. `/upload` and `/yukle` must not be treated as aliases for that queue.

## Compatibility and errors

`/upload` and `/yukle` remain behaviorally equivalent. Empty bodies and malformed JSON continue to return `400`; unauthorized requests remain rejected; oversized bodies remain rejected; and the review-only path remains fail-closed with `graphWrite: false`.

## Future queue decision

If the product later requires queued approvals for upload, that should be a separate contract change covering persistence, approval ID generation, candidate-claim visibility, operator authorization, idempotency, expiry, audit, and replay tests. This document does not claim that capability exists.
