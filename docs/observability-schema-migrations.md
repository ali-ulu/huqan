# Observability Schema Migrations

Observability schema versioning is local to observability and does not reuse SQLite’s global `PRAGMA user_version`. The canonical service bootstrap stores the current version in the namespaced `observability_schema_meta` table under the `observability` key.

## Current contract

| Version | Behavior |
| --- | --- |
| `0` | Legacy database with no observability metadata; apply the additive observability schema and record version `1`. |
| `1` | Current schema; rerun is idempotent and preserves existing rows. |
| `>1` | A newer schema is present; bootstrap fails closed with `UNSUPPORTED_OBSERVABILITY_SCHEMA_VERSION` before changing the database. |

The version-1 migration is additive. It creates observability tables and indexes with `IF NOT EXISTS`, and preserves the existing compatibility addition of `agent_id` on a pre-observability `agent_queue_jobs` table. The migration and version write run inside one SQLite transaction where the database supports transactions; the fallback path uses `BEGIN IMMEDIATE` and rolls back on failure.

The regression suite verifies legacy upgrade without data loss, idempotent rerun, queue-column addition, newer-version refusal, and rollback when the version write fails. Service construction uses this runner, so an unsupported schema cannot be silently treated as current.

## Boundary

This slice defines and tests the local SQLite migration contract only. It does not claim cross-version restore, hosted migration orchestration, rollback from version 1 to an older schema, external deployment sequencing, or a release automation policy. Backup/restore inclusion is covered separately by `docs/observability-backup-restore.md`.
