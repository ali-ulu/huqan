'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  POSIX_LAYOUT,
  posixAuthorityLayout,
  checkPosixPathTrust,
  checkPosixInstallTrust,
  checkPosixStateDirTrust,
} = require('../lib/authority/posix-path-trust');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// A stat object with just the fields the check reads. `uid` and `mode` are the
// whole evidence on POSIX, so the tests set them directly rather than touching
// a real filesystem whose ownership the runner does not control.
function stat({ uid = 0, mode = 0o755, link = false } = {}) {
  return { uid, mode, isSymbolicLink: () => link };
}

// Every component answers with the same stat, which is enough for the path
// checks: they only ever ask per-component questions.
function uniform(value) {
  return { lstat: () => value, platform: 'linux', spawn: () => { throw new Error('linux must not probe'); } };
}

function perComponent(map, fallback = stat()) {
  return { lstat: file => map[file] || fallback, platform: 'linux', spawn: () => { throw new Error('linux must not probe'); } };
}

// ─── layout ──────────────────────────────────────────────────────────────────

test('the fixed POSIX layout is what the installers and the runtime agree on', () => {
  assert.deepEqual(Object.keys(POSIX_LAYOUT).sort(), ['darwin', 'linux']);
  const linux = posixAuthorityLayout('linux');
  assert.equal(linux.installDir, '/opt/huqan-authority');
  assert.equal(linux.dataDir, '/var/lib/huqan-authority');
  assert.equal(linux.pinPath, '/var/lib/huqan-authority/public/authority.json');
  assert.equal(linux.stateDir, '/var/lib/huqan-authority/state');
  assert.equal(linux.serviceUser, 'huqan-authority');
  const darwin = posixAuthorityLayout('darwin');
  assert.equal(darwin.dataDir, '/Library/HUQAN/authority-data');
  assert.equal(darwin.pinPath, '/Library/HUQAN/authority-data/public/authority.json');
  assert.equal(darwin.serviceUser, '_huqanauthority');
});

test('a platform without POSIX parity has no layout', () => {
  assert.equal(posixAuthorityLayout('win32'), null);
  assert.deepEqual(checkPosixInstallTrust({ platform: 'win32' }), { ok: false, reason: 'install_path_untrusted' });
});

test('an inherited property name is not a platform', () => {
  // `POSIX_LAYOUT['__proto__']` is Object.prototype, which would make the join
  // below throw instead of answering null.
  for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    assert.equal(posixAuthorityLayout(name), null, name);
  }
  assert.deepEqual(checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'],
    { platform: 'toString', lstat: () => stat(), spawn: () => { throw new Error('must not probe'); } }),
  { ok: false, reason: 'install_path_untrusted' });
});

// ─── install path trust ──────────────────────────────────────────────────────

test('a root-owned, group/other-closed path is trusted', () => {
  const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'], uniform(stat()));
  assert.deepEqual(result, { ok: true });
});

test('refuses a component owned by a non-root uid', () => {
  const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'],
    perComponent({ '/opt/huqan-authority': stat({ uid: 1001 }) }));
  assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' });
});

test('refuses a group- or other-writable component', () => {
  for (const mode of [0o775, 0o757, 0o777]) {
    const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'],
      perComponent({ '/opt/huqan-authority/public': stat({ mode }) }));
    assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' }, `mode ${mode.toString(8)}`);
  }
});

test('refuses any symlinked component', () => {
  for (const component of ['/', '/opt', '/opt/huqan-authority', '/opt/huqan-authority/public',
    '/opt/huqan-authority/public/authority.json']) {
    const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'],
      perComponent({ [component]: stat({ link: true }) }));
    assert.deepEqual(result, { ok: false, reason: 'install_path_linked' }, component);
  }
});

test('fails closed when lstat throws anything but ENOENT', () => {
  for (const code of ['EACCES', 'EPERM', 'ELOOP']) {
    const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'], {
      platform: 'linux',
      spawn: () => { throw new Error('linux must not probe'); },
      lstat: () => { throw Object.assign(new Error('denied'), { code }); },
    });
    assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' }, code);
  }
});

test('a component that is simply absent is not a finding', () => {
  const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'], {
    platform: 'linux',
    spawn: () => { throw new Error('linux must not probe'); },
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(result, { ok: true });
});

test('a non-absolute path is refused rather than resolved against the cwd', () => {
  assert.deepEqual(checkPosixPathTrust(['opt/huqan-authority'], uniform(stat())),
    { ok: false, reason: 'install_path_untrusted' });
  assert.deepEqual(checkPosixPathTrust([], uniform(stat())), { ok: false, reason: 'install_path_untrusted' });
});

test('the exported path check gates the platform itself', () => {
  // A caller that reaches checkPosixPathTrust directly -- not through
  // checkPosixInstallTrust -- must not get a green light on Windows.
  const result = checkPosixPathTrust(['C:\\Program Files\\huqan-authority\\public\\authority.json'],
    { platform: 'win32', lstat: () => stat(), spawn: () => { throw new Error('must not probe'); } });
  assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' });
});

test('the install trust check walks the installed pin path', () => {
  const seen = [];
  const result = checkPosixInstallTrust({
    platform: 'linux',
    spawn: () => { throw new Error('linux must not probe'); },
    lstat: (file) => { seen.push(file); return stat(); },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(seen.includes('/var/lib/huqan-authority/public/authority.json'), 'the pin itself is inspected');
  assert.ok(seen.includes('/var/lib/huqan-authority'), 'the data root is inspected');
  assert.ok(seen.includes('/'), 'the walk reaches the root');
});

// ─── the darwin extended-ACL probe ───────────────────────────────────────────

const DARWIN_PATHS = ['/Library/HUQAN/authority-data/public/authority.json'];

function darwin(spawn) {
  return { platform: 'darwin', lstat: () => stat(), spawn };
}

test('refuses a darwin path carrying an extended ACL', () => {
  const result = checkPosixPathTrust(DARWIN_PATHS, darwin(() => ({ error: null, status: 0,
    stdout: readFixture('darwin-ls-lde-with-acl.txt') })));
  assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' });
});

test('a darwin path with no ACL entry passes the probe', () => {
  const result = checkPosixPathTrust(DARWIN_PATHS, darwin(() => ({ error: null, status: 0,
    stdout: readFixture('darwin-ls-lde-without-acl.txt') })));
  assert.deepEqual(result, { ok: true });
});

test('fails closed when the darwin ACL probe cannot run', () => {
  for (const run of [
    () => ({ error: new Error('no ls'), status: 1, stdout: '' }),
    () => ({ error: null, status: 1, stdout: readFixture('darwin-ls-lde-without-acl.txt') }),
    () => ({ error: null, status: 0, stdout: 42 }),
    () => null,
  ]) {
    const result = checkPosixPathTrust(DARWIN_PATHS, darwin(run));
    assert.deepEqual(result, { ok: false, reason: 'install_path_untrusted' });
  }
});

test('linux does not shell out to a probe', () => {
  let probed = false;
  const result = checkPosixPathTrust(['/opt/huqan-authority/public/authority.json'],
    { platform: 'linux', lstat: () => stat(), spawn: () => { probed = true; return { status: 0, stdout: '' }; } });
  assert.deepEqual(result, { ok: true });
  assert.equal(probed, false);
});

// ─── the state directory ─────────────────────────────────────────────────────
//
// `platform: 'linux'` is pinned so the darwin ACL probe never shells out to a
// real `/bin/ls`; the darwin state-dir case is covered separately below.

const SERVICE_UID = 1234;
const STATE_DIR = '/var/lib/huqan-authority/state';

test('a state dir owned by the service uid and closed to group/other is trusted', () => {
  const result = checkPosixStateDirTrust(STATE_DIR,
    { platform: 'linux', lstat: () => stat({ uid: SERVICE_UID, mode: 0o700 }), serviceUid: SERVICE_UID });
  assert.deepEqual(result, { ok: true });
});

test('refuses a state dir that is not 0700 or not owned by the service uid', () => {
  for (const value of [stat({ uid: SERVICE_UID, mode: 0o750 }), stat({ uid: SERVICE_UID, mode: 0o705 }),
    stat({ uid: 0, mode: 0o700 }), stat({ uid: SERVICE_UID, mode: 0o700, link: true })]) {
    const result = checkPosixStateDirTrust(STATE_DIR,
      { platform: 'linux', lstat: () => value, serviceUid: SERVICE_UID });
    assert.deepEqual(result, { ok: false, reason: 'state_dir_exposed' }, JSON.stringify(value.mode));
  }
});

test('a state check without a service uid, or over a missing dir, fails closed', () => {
  assert.deepEqual(checkPosixStateDirTrust(STATE_DIR, { platform: 'linux', lstat: () => stat() }),
    { ok: false, reason: 'state_dir_exposed' });
  assert.deepEqual(checkPosixStateDirTrust(STATE_DIR, {
    platform: 'linux',
    serviceUid: SERVICE_UID,
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), { ok: false, reason: 'state_dir_exposed' });
});

test('a darwin state dir with mode 0700 but an extended ACL is exposed', () => {
  const withAcl = () => ({ error: null, status: 0, stdout: readFixture('darwin-ls-lde-with-acl.txt') });
  const result = checkPosixStateDirTrust(STATE_DIR,
    { platform: 'darwin', lstat: () => stat({ uid: SERVICE_UID, mode: 0o700 }), serviceUid: SERVICE_UID, spawn: withAcl });
  assert.deepEqual(result, { ok: false, reason: 'state_dir_exposed' });
});

test('a darwin state dir ACL probe that cannot run fails closed', () => {
  const result = checkPosixStateDirTrust(STATE_DIR, {
    platform: 'darwin',
    lstat: () => stat({ uid: SERVICE_UID, mode: 0o700 }),
    serviceUid: SERVICE_UID,
    spawn: () => ({ error: new Error('no ls'), status: 1, stdout: '' }),
  });
  assert.deepEqual(result, { ok: false, reason: 'state_dir_exposed' });
});

test('linux does not probe the state dir for an ACL', () => {
  let probed = false;
  const result = checkPosixStateDirTrust(STATE_DIR, {
    platform: 'linux',
    lstat: () => stat({ uid: SERVICE_UID, mode: 0o700 }),
    serviceUid: SERVICE_UID,
    spawn: () => { probed = true; return { status: 0, stdout: '' }; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(probed, false);
});

test('the exported state check gates the platform itself', () => {
  const result = checkPosixStateDirTrust(STATE_DIR,
    { platform: 'win32', lstat: () => stat({ uid: SERVICE_UID, mode: 0o700 }), serviceUid: SERVICE_UID });
  assert.deepEqual(result, { ok: false, reason: 'state_dir_exposed' });
});

// ─── against the real filesystem ─────────────────────────────────────────────
//
// The probe only applies to the fixed POSIX layout, so these two run where the
// real path semantics match it. On Windows a tmp path is not a posix absolute
// path, and the walk refuses it as `install_path_untrusted` before it can reach
// the component under test -- correct behaviour, but not what these assert.

const posixOnly = process.platform === 'win32' && 'POSIX path semantics required';

test('refuses a real tmp directory owned by the test user', { skip: posixOnly }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-posix-trust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = checkPosixPathTrust([path.join(dir, 'public', 'authority.json')]);
  assert.equal(result.ok, false, 'a user-owned path is never an installed authority');
});

test('refuses a real symlinked component', { skip: posixOnly }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-posix-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'authority.json');
  fs.symlinkSync(path.join(dir, 'elsewhere.json'), link);
  assert.deepEqual(checkPosixPathTrust([link]), { ok: false, reason: 'install_path_linked' });
});
