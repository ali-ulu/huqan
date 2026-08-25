# Observability Retention

**Status:** Implemented as an explicit local-first cleanup API.

The observability service exposes `service.cleanup({ workspaceId, at, batchSize })` for bounded, operator-invoked retention. The operation requires one exact workspace identifier and never falls back to the default workspace. Each table is processed with its own bounded delete statement, and the cleanup runs inside the database transaction when the SQLite handle provides one.

## Default retention policy

| Record class | Default age | Eligible records |
| --- | ---: | --- |
| Events | 7 days | Any event older than the cutoff in the requested workspace |
| Runs | 30 days | `completed`, `failed`, `blocked`, or `partial` runs older than the cutoff |
| Alerts | 30 days | `resolved` alerts whose `resolved_at` is older than the cutoff |
| Queue jobs | 7 days | `completed`, `failed`, or `dead` jobs with no lease older than the cutoff |

The default batch size is `100` and the maximum accepted batch size is `1,000`. A result reports the exact workspace, cutoff timestamp, effective batch size, per-table deletion counts, and total deletion count without including payload or goal text.

Running, paused, and review-held runs and their events are preserved. Queued, leased, firing, and otherwise non-terminal records are preserved. A terminal queue record with a non-null lease is also preserved.
The service keeps the existing workspace indexes and summary queries authoritative because cleanup is performed against the same SQLite database used by observability reads.

## Safety boundary

Cleanup is explicit rather than an implicit timer or background scheduler. It is bounded to one workspace and one batch per record class per call. Invalid or ambiguous workspace identifiers and invalid timestamps fail closed with stable validation errors. Database transaction support is relied upon for all-or-nothing behavior when available; this slice does not claim a distributed retention coordinator, hosted multi-process scheduling, migration orchestration, backup/restore policy, or a user-facing retention configuration endpoint.
