'use strict';

// End-to-end install of the Windows approval authority (ADR-016, ADR-020
// open question 4 for Windows).
//
// The Windows installer tests pin its text and run the PowerShell parser over
// it; none of them runs the real thing: an elevated session, the Service
// Control Manager, WinSW and a real npm tarball. That is what this file does,
// on an ephemeral GitHub-hosted runner, and it is why it is gated by
// HUQAN_AUTHORITY_E2E: the shards must never run it (ADR-020 risk 4), because
// once the authority is installed an in-process approval is refused
// (ADR-016:150-153) and every later test in the process would see the pin.
//
// NEVER run this on a personal machine. It installs a service and writes to
// C:\Program Files and C:\ProgramData. It is meant for windows-latest only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { base32Decode, totpAt } = require('../lib/authority/totp');
const { DEFAULT_WINDOWS_INSTALL_DIR, DEFAULT_WINDOWS_PIN_PATH } = require('../lib/authority/authority-mode');

const ENABLED = process.env.HUQAN_AUTHORITY_E2E === '1';
const WINDOWS = process.platform === 'win32';
const SKIP = !ENABLED ? 'set HUQAN_AUTHORITY_E2E=1 to run the real Windows install'
  : !WINDOWS ? 'Windows required' : false;

const REPO_ROOT = path.resolve(__dirname, '..');
const DIR = path.join(REPO_ROOT, 'scripts', 'authority');
const INSTALL = path.join(DIR, 'install-authority.ps1');
const UNINSTALL = path.join(DIR, 'uninstall-authority.ps1');
const SERVICE_NAME = 'huqan-authority';
const SERVICE_ACCOUNT = 'NT SERVICE\\huqan-authority';
const PROGRAM_DIR = 'C:\\Program Files\\huqan-authority';
const DATA_DIR = DEFAULT_WINDOWS_INSTALL_DIR;
const PIN_PATH = DEFAULT_WINDOWS_PIN_PATH;
const STATE_DIR = path.win32.join(DATA_DIR, 'state');
const SECRET_PATH = path.win32.join(STATE_DIR, 'totp-secret.json');
const SC = 'C:\\Windows\\System32\\sc.exe';
const PORT = 47821;
const VERSION = require('../package.json').version;
const POWERSHELL = 'powershell.exe';
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
// Windows PowerShell 5.1 inherits PSModulePath from a pwsh 7 parent (the CI
// step shell) and then cannot load its own Microsoft.PowerShell.Security, so
// Get-AuthenticodeSignature is missing. Without it, 5.1 uses its defaults.
const PS_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));

/** sha512 in the registry's `sha512-<base64>` spelling. */
function integrityOf(file) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

function powershell(command) {
  return spawnSync(POWERSHELL, [...PS_FLAGS, '-Command', command], { encoding: 'utf8', env: PS_ENV });
}

/**
 * Run the installer, capture the enrollment secret off its output and answer
 * the prompt on stdin.
 *
 * Write-Host reaches stdout when it is redirected, but the secret is looked
 * for on both streams so the test does not depend on that. Reading to the end
 * first would block on a child waiting for input, so both are handled at once.
 */
function installWithEnrollment(tarball, integrity) {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, [...PS_FLAGS, '-File', INSTALL, '-Version', VERSION, '-Port', String(PORT),
      '-NodePath', process.execPath, '-TarballPath', tarball, '-Integrity', integrity, '-EnrollCodeStdin'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: PS_ENV });
    let out = '';
    let err = '';
    let answered = 0;
    const answerIfWanted = () => {
      const all = `${out}\n${err}`;
      const match = /secret=([A-Z2-7]+)/.exec(all);
      if (!match) return;
      // -EnrollCodeStdin prints no prompt, so the setup block is the first
      // trigger and each "did not match" is the next one.
      const wanted = 1 + (all.match(/did not match/g) || []).length;
      if (wanted <= answered) return;
      answered += 1;
      // Re-derived on every attempt so a retry after a step boundary gets the
      // next code rather than the stale one that just failed.
      child.stdin.write(`${totpAt(base32Decode(match[1]), Math.floor(Date.now() / 1000 / 30))}\n`);
    };
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); answerIfWanted(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); answerIfWanted(); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function uninstall() {
  return spawnSync(POWERSHELL, [...PS_FLAGS, '-File', UNINSTALL], { encoding: 'utf8', env: PS_ENV });
}

const state = { installed: false, packDir: null };

before(async () => {
  if (!ENABLED || !WINDOWS) return;
  const elevated = powershell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  assert.equal(elevated.stdout.trim(), 'True', 'the e2e install needs an elevated session (the hosted runner has one)');
  // A real tarball, not the checkout: the installer only ever copies the
  // bundle's files out of an unpacked package. npm is a .cmd shim on Windows.
  state.packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-e2e-pack-'));
  const packed = spawnSync('npm.cmd', ['pack', '--pack-destination', state.packDir], { cwd: REPO_ROOT, encoding: 'utf8', shell: true });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  const tarball = path.join(state.packDir, `huqan-${VERSION}.tgz`);
  assert.ok(fs.existsSync(tarball), `npm pack produced no ${tarball}`);
  const installed = await installWithEnrollment(tarball, integrityOf(tarball));
  state.installed = installed.code === 0;
  assert.equal(installed.code, 0, `installer failed (${installed.code}):\n${installed.out}\n${installed.err}`);
});

after(() => {
  if (!ENABLED || !WINDOWS) return;
  // Always take the system back to legacy mode, even when an assertion failed.
  if (state.installed) uninstall();
  if (state.packDir) fs.rmSync(state.packDir, { recursive: true, force: true });
});

test('the service exists, is running, and runs as the virtual account', { skip: SKIP }, () => {
  assert.ok(state.installed, 'the install must have succeeded');
  const query = powershell(`Get-CimInstance Win32_Service -Filter "Name='${SERVICE_NAME}'" | Select-Object Name,State,StartName | ConvertTo-Json -Compress`);
  assert.equal(query.status, 0, query.stderr);
  const service = JSON.parse(query.stdout);
  assert.equal(service.Name, SERVICE_NAME);
  assert.equal(service.State, 'Running');
  assert.equal(String(service.StartName).toLowerCase(), SERVICE_ACCOUNT.toLowerCase());
  // sc.exe is what the installer configured with; read the same record back.
  const qc = spawnSync(SC, ['qc', SERVICE_NAME], { encoding: 'utf8' });
  assert.equal(qc.status, 0, qc.stdout + qc.stderr);
  assert.match(qc.stdout, /SERVICE_START_NAME\s*:\s*NT SERVICE\\huqan-authority/i);
});

test('the runner user cannot read the TOTP secret', { skip: SKIP }, () => {
  assert.ok(state.installed, 'the install must have succeeded');
  // A real read by this process, which runs as the runner user. The runner is
  // an administrator, and the installer removed Administrators from the state
  // directory, so a plain read failing is the evidence that the boundary is
  // the ACL and not group membership.
  let denial = null;
  try {
    fs.readFileSync(SECRET_PATH, 'utf8');
  } catch (error) {
    denial = error;
  }
  assert.ok(denial, 'an unprivileged user read the TOTP secret');
  assert.match(denial.code || '', /EACCES|EPERM/, `unexpected read error: ${denial.code}`);
  assert.throws(() => fs.readdirSync(STATE_DIR), /EACCES|EPERM/, 'the state directory must not be listable');
});

test('status reports os-service and the pinned service answers', { skip: SKIP }, () => {
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'huqan-authority.js'), 'status'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `status exited ${run.status}: ${run.stdout}${run.stderr}`);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, 'service');
  assert.equal(report.boundary, 'os-service');
  assert.equal(report.answering, true);
  assert.equal(report.pinPath, PIN_PATH);
});

test('a decision without an operator code is refused', { skip: SKIP }, async () => {
  // Registering is unauthenticated by design; deciding is not. A sealed
  // request carrying a code that is not the operator's must be refused.
  const client = require('../lib/authority/authority-client');
  const { sealDecisionRequest } = require('../lib/authority/sealed-request');
  const { parseAuthorityPin } = require('../lib/authority/authority-pin');
  const { canonicalActionHash } = require('../lib/mcp-operator-capability');

  const pin = parseAuthorityPin(fs.readFileSync(PIN_PATH, 'utf8'));
  assert.equal(pin.ok, true, `the installed pin does not parse: ${pin.reason}`);
  const api = client.createAuthorityClient({ pin: pin.pin });
  const approvalId = `e2e-${crypto.randomBytes(8).toString('hex')}`;
  const args = { text: 'e2e authority sentinel' };
  const tool = 'huqan.learn';
  const actionHash = canonicalActionHash({ tool, workspaceId: 'default', approvalId, arguments: args });

  const registered = await api.register({
    approvalId, workspaceId: 'default', tool, arguments: args, actionHash,
    consumeProofHash: crypto.randomBytes(32).toString('hex'),
    summary: `${tool} e2e`,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  assert.equal(registered.status, 201, `register failed: ${JSON.stringify(registered.body)}`);
  const sealed = sealDecisionRequest({ approvalId, actionHash, decision: 'approved', reason: 'e2e', totp: '000000' }, pin.pin.sealingKey);
  const decided = await api.decide(approvalId, sealed);
  assert.notEqual(decided.status, 200, 'a decision was accepted without the operator code');
  assert.ok(['TOTP_INVALID', 'TOTP_REPLAYED', 'LOCKED'].includes(decided.body.code), `unexpected refusal ${JSON.stringify(decided.body)}`);
});

test('uninstall leaves no service, no pin, no program directory, and archives the state', { skip: SKIP }, () => {
  const removed = uninstall();
  assert.equal(removed.status, 0, `uninstaller failed: ${removed.stdout}${removed.stderr}`);
  state.installed = false;
  const sc = spawnSync(SC, ['query', SERVICE_NAME], { encoding: 'utf8' });
  assert.notEqual(sc.status, 0, 'the service must be gone');
  assert.match(sc.stdout, /1060/, 'sc query must report that the service does not exist');
  assert.equal(fs.existsSync(PIN_PATH), false, 'the pin must be gone: removing it is the way back to legacy');
  assert.equal(fs.existsSync(PROGRAM_DIR), false, 'the protected program directory must be gone');
  assert.equal(fs.existsSync(DATA_DIR), false, 'the protected data directory must have been renamed away');
  // The state directory is renamed, not deleted, so the ledger stays auditable.
  const parent = path.win32.dirname(DATA_DIR);
  const prefix = `${path.win32.basename(DATA_DIR)}.removed-`;
  const archived = fs.readdirSync(parent).filter(name => name.startsWith(prefix));
  assert.equal(archived.length, 1, 'the state must be kept under a .removed- name');
});
