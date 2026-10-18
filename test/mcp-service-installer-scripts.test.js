'use strict';

// The Windows installer cannot run in CI, so its load-bearing properties are
// pinned here, and on Windows its syntax is checked by the PowerShell parser
// itself -- the same pattern test/authority-installer-scripts.test.js uses.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'scripts', 'mcp-service');
const SCRIPTS = ['install-mcp-service.ps1', 'uninstall-mcp-service.ps1'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const install = read('install-mcp-service.ps1');
const uninstall = read('uninstall-mcp-service.ps1');

test('the scripts are pure ASCII, because Windows PowerShell 5.1 misreads anything else', () => {
  for (const name of SCRIPTS) {
    const offending = [...read(name)].findIndex((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
    assert.equal(offending, -1, `${name} has a non-ASCII character at ${offending}`);
  }
});

test('the installer writes exactly where the runtime looks, and takes no path from the environment', () => {
  assert.ok(install.includes('$DataDir = "C:\\ProgramData\\huqan\\mcp\\$Name"'));
  assert.ok(install.includes('$ProgramDir = "C:\\Program Files\\huqan-mcp\\$Name"'));
  assert.ok(install.includes("$StoreRoot = 'C:\\ProgramData\\huqan\\state'"));
  assert.doesNotMatch(install, /\$env:(ProgramFiles|ProgramData|SystemRoot|windir|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP)/i);
});

test('one virtual account per server, configured the authority way', () => {
  assert.ok(install.includes('$ServiceAccount = "NT SERVICE\\$ServiceName"'));
  assert.match(install, /'obj=', \$ServiceAccount/);
  assert.match(install, /'sidtype', \$ServiceName, 'unrestricted'/);
});

test('the state tree carries no ACE beyond SYSTEM, Administrators, the operator and the service SID', () => {
  const lines = install.split('\n');
  const grantIndex = lines.findIndex((line) => line.includes('$StateDir') && line.includes('/inheritance:r'));
  assert.ok(grantIndex >= 0, 'the state ACL drops inheritance');
  const grantBlock = lines.slice(grantIndex, grantIndex + 3).join(' ');
  assert.doesNotMatch(grantBlock, /Users/);
  assert.ok(grantBlock.includes('${OperatorAccount}:(OI)(CI)F'), 'the operator holds the state tree');
  assert.ok(grantBlock.includes('${ServiceAccount}:(OI)(CI)M'), 'the service SID holds Modify on its own state');
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

test('the service runs node and the app from the protected program directory only', () => {
  assert.match(install, /\$NodeExe = Join-Path \$ProgramDir 'node\\node\.exe'/);
  assert.match(install, /<executable>\$NodeExe<\/executable>/);
  assert.match(install, /lib\\mcp\\service-main\.js/);
  assert.match(install, /--app-root "\$AppDir"/);
});

test('the installer proves the listener is fail-closed before declaring success', () => {
  assert.match(install, /answered an unsigned request/);
  assert.match(install, /403/);
});

test('the server account must hold no ACE on the protected memory store', () => {
  assert.match(install, /holds an ACE on \$StoreRoot/);
  assert.ok(install.includes("if (Test-Path -LiteralPath $StoreRoot)"), 'the store check runs when the store exists');
});

test('the client surfaces the installer prints exist', () => {
  assert.match(install, /huqan mcp config --name \$Name/);
  assert.match(install, /huqan mcp status --name \$Name/);
});

test('uninstall keeps the registry for audit and removes the program directory', () => {
  assert.match(uninstall, /State and registry kept at/);
  assert.match(uninstall, /Rename-Item -LiteralPath \$DataDir/);
  assert.match(uninstall, /Remove-Item -LiteralPath \$ProgramDir -Recurse -Force/);
  assert.match(uninstall, /run this from an elevated PowerShell/);
});

test('uninstall targets the very program directory the installer creates', () => {
  const programDir = (source) => /\$ProgramDir = "([^"]+)"/.exec(source)[1];
  assert.equal(programDir(uninstall), programDir(install));
});

test('the installer compares SIDs, not account names, and tolerates a service that is still starting', () => {
  assert.match(install, /function ConvertTo-SidText/);
  assert.ok(!install.includes('$rule.IdentityReference.Value -eq'), 'no name comparison against the service account');
  assert.match(install, /\$failure\.PSObject\.Properties\['Response'\]/);
  assert.ok(install.indexOf("Fail \"the service answered an unsigned request") > install.indexOf('if ($status -eq 403) { return }'),
    'the unsigned-answer failure is raised outside the try, where its own catch cannot swallow it');
});

test('the PowerShell parser accepts both scripts', { skip: process.platform !== 'win32' && 'PowerShell is checked on Windows' }, () => {
  for (const name of SCRIPTS) {
    const command = `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${path.join(DIR, name)}', [ref]$null, [ref]$errors) | Out-Null; $errors.Count`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '0', `${name}: ${run.stdout}`);
  }
});
