# Observability release and rollback checklist

This checklist covers the local-first observability subsystem. It does not authorize an npm publish or a hosted deployment.

## Before release

1. Use a clean checkout at the exact candidate SHA and confirm every stacked prerequisite is merged.
2. Run the `Observability release gate`; do not substitute a targeted local test for its unit, migration, backup/restore, load, soak, package-closure, and installed-tarball jobs.
3. Create a filesystem backup with `npm run backup` and retain its operation receipt and safety-backup location.
4. Confirm the candidate package version and release tag agree. Schema changes must remain additive and `OBSERVABILITY_SCHEMA_VERSION` must match the tested migration.
5. Record known limitations: internal metrics are process-local and the local rate limiter is not a distributed coordination mechanism.

## Migration failure

- A database whose schema version is newer than the runtime must stop with `OBSERVABILITY_SCHEMA_VERSION_UNSUPPORTED`; never rewrite its version marker.
- A failed migration transaction must leave the pre-migration database readable. Preserve the database, WAL, and SHM files together for diagnosis.
- Do not delete or recreate observability tables to make startup pass. Restore the safety backup or deploy the previous compatible binary.

## Rollback drill

1. Stop the server and worker before replacing SQLite files.
2. Preserve the failed candidate database as an immutable diagnostic copy.
3. Run `npm run restore -- <backup-directory>` and retain the restore receipt. A partial receipt is not success; follow its `restored`, `skipped`, and `safetyBackupDir` fields.
4. Start the previous package version. Verify schema version, `/health`, `/ready`, and authenticated `/api/v1/observability/metrics` for the intended workspace.
5. Verify a pre-release event, run, queue job, and alert remain readable and cross-workspace reads remain denied.
6. Re-run the backup/restore, schema-migration, and observability contract tests before reopening traffic.

Rollback is complete only when the previous binary reads the restored data and the negative workspace/auth tests still pass. Merely starting the process is insufficient.

