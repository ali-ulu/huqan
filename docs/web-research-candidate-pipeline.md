# Web research candidate pipeline

Issue #2144 connects external web research to HUQAN's candidate and contradiction path without promoting external content into canonical graph truth.

## Contract

The normal web-research request remains read-only. Candidate creation is explicit:

```json
{
  "workspaceId": "default",
  "provider": "tavily",
  "query": "engine operating limit",
  "openCandidates": true
}
```

When `openCandidates` is true, every usable external result is written only as a candidate claim with these invariants:

- `status: pending`
- `recommendation: flag`
- `proposedEdge: null`
- `evidenceStatus: external_unverified` remains unchanged on the research result
- `canonicalWrite: false`
- provenance identifies the provider URL and `sourceSubType: web-research:<provider>`
- candidate writes go through `kernel.addCandidateClaim`, which is the admitted candidate mutation seam
- the research path never calls `Graph.addNode` or `Graph.addEdge`

A repeated provider result produces the same candidate id, so the candidate-store upsert does not create duplicate review objects.

## Contradiction pass

The pipeline compares a bounded set of canonical graph edges with each external snippet. A pair is evaluated only when the external text mentions the canonical subject or has meaningful textual overlap. The existing nine-rule contradiction engine then produces signals.

Signals are attached to the pending candidate. Issue #2146 also projects each contradiction into a candidate-scoped external-source opposition record. The record names the canonical edge target, carries the external source provenance, and uses the explicit relation `OPPOSES`.

These opposition records are **not canonical graph edges**. They remain inside the pending candidate conflict object, so the research path still never calls `Graph.addNode` or `Graph.addEdge`. Trust/provenance reads can target the canonical edge id and surface the pending external opposition without granting it canonical authority.

The scan is bounded to 500 canonical edges and 8 contradiction signals per external source. The response reports whether the edge scan was truncated.

## Summary semantic verification

When HUQAN produces a web-research summary, the workflow runs the same bounded contradiction rules against canonical graph evidence. The result is returned as `summaryVerification`.

A summary can be:

- `opposed` when contradiction signals are found;
- `no_contradiction_found` when the bounded pass finds none;
- `unavailable` when graph evidence cannot be read.

None of those states means the summary is true. `verified` remains `false`, `evidenceStatus` remains `external_unverified`, and `canonicalWrite` remains `false`. Summary opposition records carry the summary provenance and canonical target provenance in the same read-only shape used by source candidates.

## Failure behavior

Candidate mode is fail-closed. If the Kernel candidate store is unavailable, or mutation admission refuses the pending candidate write, the workflow fails instead of returning a successful candidate-mode result that did not create reviewable state.

Provider fetching and candidate admission are separate trust boundaries. A successful fetch never grants canonical authority to the fetched text.
