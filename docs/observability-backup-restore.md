# Observability Backup and Restore

Observability events, runs, alerts, alert rules and queue jobs are stored in the runtime SQLite database used by Huqan. The existing backup flow therefore includes them through the same validated SQLite online backup of `memory.db`; no separate observability export file is introduced.

## Verified contract

The integration regression test `test/observability-backup-restore.integration.test.js` uses a real Huqan storage SQLite database, writes event/run/queue/alert state for two workspaces, creates a backup, removes the live rows, restores the backup, and opens the database again. It verifies the following behavior:

| Area | Verified behavior |
| --- | --- |
| Persistence | `memory.db` is present in the backup manifest and restores successfully. |
| Events and runs | `run_started`, `step_finished`, `run_finished`, and their run projection remain readable after restore. |
| Queue | The queued job and its status remain readable after restore. |
| Alerts | The alert rule and fired alert remain readable after restore. |
| Workspace scope | Workspace A data remains available only to Workspace A queries; an unrelated Workspace C receives no rows. |
| Restore safety | Existing restore verification and the pre-restore safety backup remain active. |

The test deliberately uses the repository’s normal storage schema, so SQLite integrity/schema validation is exercised instead of copying an observability-only database fixture.

## Boundaries

This slice proves backup/restore inclusion and workspace-scoped read parity for the current local-first SQLite runtime. It does not claim schema migration versioning, backup encryption, secret scanning beyond the existing redaction/persistence contracts, remote backup storage, cross-version restore compatibility, or automatic backup scheduling. Those concerns remain separate P1.2/P2.3 work and are not closed by this change.
