'use strict';

// End-to-end install of the POSIX approval authority (ADR-020 sections 1-3,
// #4082 PR-6).
//
// Every other POSIX test pins the installers' text or drives the runtime
// in-process. None of them runs the real thing: root, a real service manager
// and a real npm tarball. That is what this file does, on an ephemeral CI
// runner, and it is why it is gated by HUQAN_AUTHORITY_E2E: the shards must
// never run it (ADR-020 risk 4), because once the authority is installed an
// in-process approval is refused (ADR-016:150-153) and every later test in the
// process would see the installed pin.
//
// The five claims it falsifies are the ones a reader cannot check by reading
// code: the operator user cannot read the TOTP secret, the runtime resolves
// the installed pin to `os-service` and the service answers under it, a
// decision without an operator code is refused, loosening the public directory
// drops the mode to `required_unavailable` (never legacy), and uninstall takes
// the unit and the pin away.
//
// The service user is left behind on purpose (both uninstallers say so): the
// renamed state directory is owned by that uid, and deleting the account would
// orphan it. The last case therefore asserts what the uninstaller promises --
// no unit, no pin, state archived -- not "no user".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { base32Decode, totpAt } = require('../lib/authority/totp');
const { posixAuthorityLayout } = require('../lib/authority/posix-path-trust');

const ENABLED = process.env.HUQAN_AUTHORITY_E2E === '1';
// The Windows shard loads this file too, and `posixAuthorityLayout` answers
// null there, so every path is derived behind the platform gate. A test that
// still reaches a path is skipped for the same reason.
const POSIX = process.platform !== 'win32';
const SKIP = !ENABLED ? 'set HUQAN_AUTHORITY_E2E=1 to run the real POSIX install'
  : !POSIX ? 'POSIX path semantics required' : false;

const REPO_ROOT = path.resolve(__dirname, '..');
const DIR = path.join(REPO_ROOT, 'scripts', 'authority');
const IS_DARWIN = process.platform === 'darwin';
const INSTALL = path.join(DIR, IS_DARWIN ? 'install-authority-darwin.sh' : 'install-authority.sh');
const UNINSTALL = path.join(DIR, IS_DARWIN ? 'uninstall-authority-darwin.sh' : 'uninstall-authority.sh');
const LAYOUT = POSIX ? posixAuthorityLayout(process.platform) : null;
const PIN_PATH = LAYOUT ? LAYOUT.pinPath : null;
const SECRET_PATH = LAYOUT ? path.posix.join(LAYOUT.stateDir, 'totp-secret.json') : null;
const PORT = 47821;

const VERSION = require('../package.json').version;

function sudo(args, options = {}) {
  return spawnSync('sudo', args, { encoding: 'utf8', ...options });
}

/** sha512 in the registry's `sha512-<base64>` spelling. */
function integrityOf(file) {
  return `sha512-${crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

/**
 * Run the installer, capture the enrollment secret off stderr and answer the
 * prompt on stdin.
 *
 * The installer prints the setup key and the otpauth URI to stderr and reads
 * the six-digit code from stdin, so both have to be handled at once: reading
 * stderr to completion first would block on a child waiting for input.
 */
function installWithEnrollment(tarball, integrity) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['bash', INSTALL, '--version', VERSION, '--port', String(PORT),
      '--tarball', tarball, '--integrity', integrity, '--enroll-code-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let answered = 0;
    const answer = (secret) => {
      answered += 1;
      // The installer just created the secret; the current step's code opens it.
      // totpAt is re-derived on every attempt so a retry after a step boundary
      // gets the next code rather than the stale one that just failed.
      child.stdin.write(`${totpAt(base32Decode(secret), Math.floor(Date.now() / 1000 / 30))}\n`);
    };
    const onChunk = (chunk) => {
      err += chunk.toString('utf8');
      const match = /secret=([A-Z2-7]+)/.exec(err);
      if (!match) return;
      // `--enroll-code-stdin` prints no prompt, so the setup block is the first
      // trigger and each "did not match" is the next one.
      const wanted = 1 + (err.match(/did not match/g) || []).length;
      if (wanted > answered) answer(match[1]);
    };
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', onChunk);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const state = { tarball: null, integrity: null, installed: false, packDir: null };

before(async () => {
  if (!ENABLED || !POSIX) return;
  // The hosted runners are not root: the test process is the unprivileged
  // runner user and only `sudo` reaches root, which is exactly the split the
  // install is built around.
  const probe = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, 'the e2e install needs passwordless sudo');
  // A real tarball, not the checkout: the installer only ever copies the
  // bundle's files out of an unpacked package.
  state.packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-e2e-pack-'));
  const packed = spawnSync('npm', ['pack', '--pack-destination', state.packDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  state.tarball = path.join(state.packDir, `huqan-${VERSION}.tgz`);
  assert.ok(fs.existsSync(state.tarball), `npm pack produced no ${state.tarball}`);
  state.integrity = integrityOf(state.tarball);
  const installed = await installWithEnrollment(state.tarball, state.integrity);
  state.installed = installed.code === 0;
  assert.equal(installed.code, 0, `installer failed (${installed.code}):\n${installed.out}\n${installed.err}`);
});

after(() => {
  if (!ENABLED || !POSIX) return;
  // Always take the system back to legacy mode, even when an assertion failed:
  // the runner is ephemeral, but a half-installed service would make the next
  // case report the wrong thing.
  sudo(['bash', UNINSTALL]);
  if (state.packDir) fs.rmSync(state.packDir, { recursive: true, force: true });
});

test('the runner user cannot read the TOTP secret', { skip: SKIP }, () => {
  assert.ok(state.installed, 'the install must have succeeded');
  // Inspected through sudo: the state directory is 0700 and owned by the
  // service user, so the runner user cannot even stat the file inside it --
  // which is the point. A plain fs.statSync here would throw EACCES.
  const stat = spawnSync('sudo', ['stat', '-c', '%u %a', SECRET_PATH], { encoding: 'utf8' });
  if (stat.status !== 0) {
    // macOS stat has no -c.
    const mac = spawnSync('sudo', ['stat', '-f', '%u %Lp', SECRET_PATH], { encoding: 'utf8' });
    assert.equal(mac.status, 0, `cannot stat the secret: ${mac.stderr}`);
    assert.match(mac.stdout.trim(), /^\d+ (600|0700)$/, `unexpected secret mode: ${mac.stdout.trim()}`);
    assert.notEqual(mac.stdout.trim().split(' ')[0], '0', 'the secret must be owned by the service user, not root');
  } else {
    const [uid, mode] = stat.stdout.trim().split(' ');
    assert.notEqual(uid, '0', 'the secret must be owned by the service user, not root');
    assert.equal(mode, '600', `the secret file must be 0600, got ${mode}`);
  }
  // Read as the runner user itself, not as root: this is the evidence that the
  // boundary is a real OS one and not just a mode bit. This process runs as the
  // runner user, so its own read is the unprivileged read.
  let denial = null;
  try {
    fs.readFileSync(SECRET_PATH, 'utf8');
  } catch (error) {
    denial = error;
  }
  assert.ok(denial, 'an unprivileged user read the TOTP secret');
  assert.match(denial.code || '', /EACCES|EPERM/, `unexpected read error: ${denial.code}`);
});

test('status reports os-service and the pinned service answers', { skip: SKIP }, () => {
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'huqan-authority.js'), 'status'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `status exited ${run.status}: ${run.stderr}`);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mode, 'service');
  assert.equal(report.boundary, 'os-service');
  assert.equal(report.answering, true);
  assert.equal(report.pinPath, PIN_PATH);
});

test('a decision without an operator code is refused', { skip: SKIP }, () => {
  // Registering is unauthenticated by design; deciding is not. A sealed
  // request carrying a code that is not the operator's must be refused, and
  // the approval must stay pending.
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

  return api.register({
    approvalId, workspaceId: 'default', tool, arguments: args,
    actionHash: canonicalActionHash({ tool, workspaceId: 'default', approvalId, arguments: args }),
    consumeProofHash: crypto.randomBytes(32).toString('hex'),
    summary: `${tool} e2e`,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }).then(async (registered) => {
    assert.equal(registered.status, 201, `register failed: ${JSON.stringify(registered.body)}`);
    const sealed = sealDecisionRequest({ approvalId, actionHash: canonicalActionHash({ tool, workspaceId: 'default', approvalId, arguments: args }),
      decision: 'approved', reason: 'e2e', totp: '000000' }, pin.pin.sealingKey);
    const decided = await api.decide(approvalId, sealed);
    assert.notEqual(decided.status, 200, 'a decision was accepted without the operator code');
    assert.ok(['TOTP_INVALID', 'TOTP_REPLAYED', 'LOCKED'].includes(decided.body.code), `unexpected refusal ${JSON.stringify(decided.body)}`);
  });
});

test('loosening the public directory drops the mode to required_unavailable, never legacy', { skip: SKIP }, () => {
  // A pin under a world-writable directory could be planted by any local user,
  // so the runtime must refuse it -- and it must refuse by name, not fall back
  // to the same-user path the pin was meant to replace.
  sudo(['chmod', '0777', path.posix.dirname(PIN_PATH)]);
  try {
    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'huqan-authority.js'), 'status'], { encoding: 'utf8' });
    assert.equal(run.status, 2, `status exited ${run.status}: ${run.stdout}${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.mode, 'required_unavailable');
    assert.equal(report.reason, 'install_path_untrusted');
  } finally {
    sudo(['chmod', '0755', path.posix.dirname(PIN_PATH)]);
  }
});

test('uninstall leaves no unit, no pin, and archives the state', { skip: SKIP }, () => {
  const removed = sudo(['bash', UNINSTALL]);
  assert.equal(removed.status, 0, `uninstaller failed: ${removed.stderr}`);
  state.installed = false;
  assert.equal(fs.existsSync(PIN_PATH), false, 'the pin must be gone: removing it is the way back to legacy');
  assert.equal(fs.existsSync(LAYOUT.installDir), false, 'the protected program directory must be gone');
  if (IS_DARWIN) {
    assert.equal(fs.existsSync('/Library/LaunchDaemons/com.huqan.authority.plist'), false, 'the plist must be gone');
  } else {
    const unit = spawnSync('systemctl', ['list-unit-files', 'huqan-authority.service'], { encoding: 'utf8' });
    assert.doesNotMatch(unit.stdout, /huqan-authority\.service/, 'the unit must be gone');
  }
  // The state directory is renamed, not deleted, so the ledger stays auditable.
  const archived = fs.readdirSync(path.posix.dirname(LAYOUT.dataDir)).filter(name => name.startsWith(`${path.posix.basename(LAYOUT.dataDir)}.removed-`));
  assert.equal(archived.length, 1, 'the state must be kept under a .removed- name');
});
