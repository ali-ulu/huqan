#!/usr/bin/env node
require('../lib/environment-compat').validateEnvironmentCompatibility();
const { restoreBackup } = require('../backupRestore');

try {
  const backupDir = process.argv[2];
  const result = restoreBackup(backupDir ? { backupDir } : {});
  process.stdout.write(`Restore tamamlandi: ${result.sourceDir}\n`);
  process.stdout.write(`Geri yuklenen dosyalar: ${result.restored.length}\n`);
  process.stdout.write(`Guvenlik yedegi: ${result.safetyBackupDir}\n`);
} catch (error) {
  process.stderr.write(`Restore hatasi: ${error.message}\n`);
  process.exit(1);
}
