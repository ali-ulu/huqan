// Backup and restore. Paths and ids, the on-disk store, backup creation,
// restore validation and the restore itself live in lib/storage/backup-restore-*.js
// (#2168); this module keeps the CLI helpers and the public surface.

const { DEFAULT_FILES, timestamp, resolveRuntimePaths } = require('./lib/storage/backup-restore-paths');
const { createBackup, listBackups } = require('./lib/storage/backup-restore-create');
const { previewRestore, restoreBackup } = require('./lib/storage/backup-restore-restore');

function runCliRestore(args, opts = {}) {
  const requested = args && typeof args === 'object' ? args : { backupDir: args || undefined };
  return requested.dryRun
    ? previewRestore({ ...opts, backupDir: requested.backupDir || undefined })
    : restoreBackup({ ...opts, backupDir: requested.backupDir || undefined });
}

function formatCliRestore(result, json = false) {
  if (json) return result;
  if (result.dryRun) return `Restore dry-run: ${result.scope.files.length} files, ${result.conflicts.length} conflicts, schema ${result.schemaVersion}.`;
  return `Restore tamamlandi: ${result.restored.length} dosya geri yüklendi. Guvenlik yedegi: ${result.safetyBackupDir}. Verification: ${Object.values(result.verification).every(Boolean) ? 'passed' : 'failed'}`;
}

/**
 * Formats a restore failure for CLI/script stderr output. A partial restore
 * already carries an exact `error.receipt` (status/restored/skipped/
 * safetyBackupDir/message, see restoreBackup); printing only `error.message`
 * made a half-restored state indistinguishable from "nothing happened" and
 * hid the safety-backup recovery path (#1981, H-08). Errors without a
 * receipt (e.g. RESTORE_SOURCE_INVALID pre-validation, by design) fall back
 * to the plain message line.
 */
function formatRestoreError(error) {
  const lines = [`Restore hatasi: ${error?.message || error}`];
  const receipt = error?.receipt;
  if (receipt && typeof receipt === 'object') {
    if (receipt.status) lines.push(`Durum: ${receipt.status}`);
    if (Array.isArray(receipt.restored)) lines.push(`Geri yuklenen dosyalar: ${receipt.restored.length > 0 ? receipt.restored.join(', ') : '-'}`);
    if (Array.isArray(receipt.skipped)) lines.push(`Atlanan dosyalar: ${receipt.skipped.length > 0 ? receipt.skipped.join(', ') : '-'}`);
    if (receipt.safetyBackupDir) lines.push(`Guvenlik yedegi: ${receipt.safetyBackupDir}`);
    if (receipt.message && receipt.message !== error?.message) lines.push(`Detay: ${receipt.message}`);
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_FILES,
  createBackup,
  listBackups,
  resolveRuntimePaths,
  restoreBackup,
  previewRestore,
  runCliRestore,
  formatCliRestore,
  formatRestoreError,
  timestamp,
};
