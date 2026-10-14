'use strict';

// ADR-016 P5: the Windows installer cannot run in CI, so its load-bearing
// properties are pinned here, and on Windows its syntax is checked by the
// PowerShell parser itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_WINDOWS_INSTALL_DIR, DEFAULT_WINDOWS_PIN_PATH } = require('../lib/authority/authority-mode');

const DIR = path.join(__dirname, '..', 'scripts', 'authority');
const SCRIPTS = ['install-authority.ps1', 'uninstall-authority.ps1'];
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
const install = read('install-authority.ps1');

test('the scripts are pure ASCII, because Windows PowerShell 5.1 misreads anything else', () => {
  for (const name of SCRIPTS) {
    const offending = [...read(name)].findIndex(ch => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
    assert.equal(offending, -1, `${name} has a non-ASCII character at ${offending}`);
  }
});

test('the installer writes exactly where the runtime looks, and takes no path from the environment', () => {
  assert.ok(install.includes(`$DataDir = '${DEFAULT_WINDOWS_INSTALL_DIR}'`));
  assert.equal(path.win32.join(DEFAULT_WINDOWS_INSTALL_DIR, 'public', 'authority.json'), DEFAULT_WINDOWS_PIN_PATH);
  assert.ok(install.includes("$ProgramDir = 'C:\\Program Files\\huqan-authority'"));
  assert.doesNotMatch(install, /\$env:(ProgramFiles|ProgramData|SystemRoot|windir|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP)/i);
});

test('the state directory is closed to users and, after enrollment, to administrators', () => {
  const stateGrant = install.split('\n').find(line => line.includes('$StateDir') && line.includes('/inheritance:r'));
  assert.ok(stateGrant, 'the state ACL drops inheritance');
  assert.doesNotMatch(stateGrant, /Users/);
  assert.match(install, /\$StateDir, '\/remove:g', \$Sid\.Admins, '\/T'/);
  assert.match(install, /'\/setowner', \$Sid\.System/);
});

test('the installer refuses ground it did not prepare and code it cannot vouch for', () => {
  assert.match(install, /already exists; remove it/);
  assert.match(install, /\$WinSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'/);
  assert.match(install, /OpenJS Foundation/);
  assert.match(install, /'sha512-' \+ \[Convert\]::ToBase64String\(\$bytes\)\) -ne \$integrity/);
  assert.match(install, /<env name="NODE_OPTIONS" value="" \/>/);
  assert.match(install, /ReparsePoint/);
});

test('the service runs node and the bundle from the protected program directory only', () => {
  assert.match(install, /\$NodeExe = Join-Path \$ProgramDir 'node\\node\.exe'/);
  assert.match(install, /<executable>\$NodeExe<\/executable>/);
  assert.match(install, /\$serviceMain = Join-Path \$AppDir 'lib\\authority\\service-main\.js'/);
  assert.match(install, /'obj=', \$ServiceAccount/);
});

test('the operator window is a Start menu shortcut that always asks to elevate', () => {
  assert.match(install, /Start Menu\\Programs\\HUQAN Authority\.lnk/);
  assert.match(install, /\$bytes\[0x15\] = \$bytes\[0x15\] -bor 0x20/);
  assert.match(install, /lib\\authority\\operator-cli\.js/);
});

test('the PowerShell parser accepts both scripts', { skip: process.platform !== 'win32' && 'PowerShell is checked on Windows' }, () => {
  for (const name of SCRIPTS) {
    const command = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path.join(DIR, name)}', [ref]$null, [ref]$errors) | Out-Null; $errors.Count`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '0', `${name}: ${run.stdout}`);
  }
});
