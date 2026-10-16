#!/usr/bin/env node
require('../lib/environment-compat').validateEnvironmentCompatibility();
const { createBackup } = require('../backupRestore');

try {
  const backupBaseDir = process.argv[2];
  const result = createBackup(backupBaseDir ? { backupBaseDir } : {});
  process.stdout.write(`Backup tamamlandi: ${result.backupDir}\n`);
  process.stdout.write(`Kopyalanan dosyalar: ${result.copied.length}\n`);
} catch (error) {
  process.stderr.write(`Backup hatasi: ${error.message}\n`);
  process.exit(1);
}
