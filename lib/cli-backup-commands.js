'use strict';

// The CLI `backup` and `restore` commands. Moved out of cli.js (#2136)
// unchanged, together with the backupRestore require only they used, so
// cli.js's fan-out does not rise. They receive the command context CLI#execute
// builds. The sqlite-restore require stays inside the restore body, so it
// is still loaded only when a restore runs.
const { createBackup, runCliRestore, formatCliRestore, formatRestoreError } = require('../backupRestore');

function runBackupCommand(cli) {
  const result = createBackup(cli.backupOptions());
  return `Backup complete: ${result.backupDir} (${result.copied.length} files)${cli.commitCliMutation('backup')}`;
}

function runRestoreCommand(cli, args, opts) {
  // Windows EPERM guard (#1848): memory.db is open, so close every handle before restore replaces it.
  const { storageWasOpen, closeRestoreHandles, reopenRestoreHandles } = require('./sqlite-restore');
  const storage = cli.agent?.storage;
  const storageOpen = storageWasOpen(storage);
  closeRestoreHandles({ kernel: cli.kernel, storage });
  let result;
  try {
    result = runCliRestore(args, cli.backupOptions({ backupDir: args?.backupDir || args || undefined }));
  } catch (error) {
    throw Object.assign(new Error(formatRestoreError(error)), { code: error.code, receipt: error.receipt });
  } finally {
    // Only reopen handles we actually closed: agent storage may already be
    // closed (tests, standalone reads) or point at a file restore replaced.
    // Reopening one that was closed up front would try to open whatever it
    // resolved to and can throw SQLITE_NOTADB for a non-database path.
    reopenRestoreHandles({ kernel: cli.kernel, storage, storageOpen });
  }
  if (!result.dryRun) { cli.kernel.reload(); cli.commitCliMutation('restore'); }
  return formatCliRestore(result, opts.json);
}

module.exports = { runBackupCommand, runRestoreCommand };
