'use strict';

// The Linux installer cannot run in CI (it needs root, a package manager and a
// live systemd), so its load-bearing properties are pinned here and its syntax
// is checked by bash itself -- the same pattern
// test/authority-installer-scripts.test.js uses for the PowerShell pair
// (ADR-020 section 1-3, #4082 PR-4).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { posixAuthorityLayout } = require('../lib/authority/posix-path-trust');

const DIR = path.join(__dirname, '..', 'scripts', 'authority');
const SCRIPTS = ['install-authority.sh', 'uninstall-authority.sh'];
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// .gitattributes pins LF for these files, but a checkout that ignores it would
// still hand us CRLF; normalise so the multi-line pins below compare content,
// not line-ending style.
const lf = text => text.replace(/\r\n/g, '\n');
const install = lf(read('install-authority.sh'));
const uninstall = lf(read('uninstall-authority.sh'));

test('the scripts are pure ASCII, because a non-UTF-8 locale would misread anything else', () => {
  for (const name of SCRIPTS) {
    const offending = [...read(name)].findIndex(ch => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
    assert.equal(offending, -1, `${name} has a non-ASCII character at ${offending}`);
  }
});

// The script text goes in on stdin, not as a path: on Windows `bash` may be the
// WSL stub, which eats a native `C:\...` argument. The normalised text is the
// same text .gitattributes guarantees on checkout, so this parses the shipped
// bytes wherever the checkout happened.
test('bash parses both scripts', () => {
  for (const name of SCRIPTS) {
    const run = spawnSync('bash', ['-n'], { input: lf(read(name)), encoding: 'utf8' });
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
});

test('the installer writes exactly where the runtime looks, and takes no path from the environment', () => {
  const layout = posixAuthorityLayout('linux');
  assert.ok(install.includes(`INSTALL_DIR=${layout.installDir}`));
  assert.ok(install.includes(`DATA_DIR=${layout.dataDir}`));
  assert.ok(install.includes(`SERVICE_USER=${layout.serviceUser}`));
  // The resolver's fixed pin path is the one the service writes.
  assert.ok(install.includes('PIN_FILE="$PUBLIC_DIR/authority.json"'));
  assert.equal(path.posix.join(layout.dataDir, 'public', 'authority.json'), layout.pinPath);
  assert.doesNotMatch(install, /\$\{(?:HOME|USER|TMPDIR|XDG_[A-Z_]+)\}/);
  assert.doesNotMatch(install, /INSTALL_DIR=\$\{/);
});

test('node is verified against the GPG-signed manifest, with no unverified path', () => {
  assert.ok(install.includes('NODE_KEYRING_URL=https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx'));
  assert.match(install, /SHASUMS256\.txt\.asc/);
  assert.match(install, /gpg --batch --no-default-keyring --keyring[\s\S]*?--decrypt/);
  assert.match(install, /sha256sum -c -/);
  assert.match(install, /MIN_NODE=22\.13\.0/);
  assert.doesNotMatch(install, /allow-unverified-node/);
});

test('the node tarball is chosen from the host architecture, not a hardcoded x64', () => {
  assert.match(install, /x86_64\|amd64\) printf '%s' x64/);
  assert.match(install, /aarch64\|arm64\) printf '%s' arm64/);
  assert.match(install, /\*\) fail "unsupported architecture: \$\(uname -m\)"/);
  assert.match(install, /tarball="node-v\$\{ver\}-linux-\$\{arch\}\.tar\.xz"/);
  assert.match(install, /extract_dir="node-v\$\{ver\}-linux-\$\{arch\}"/);
  assert.doesNotMatch(install, /linux-x64\.tar\.xz/);
});

test('the package is checked against the registry integrity before it is unpacked', () => {
  // The integrity lives under dist in a version document; a top-level read
  // would yield nothing and the installer would abort.
  assert.match(install, /integrity="\$\(json_field "\$meta" dist\.integrity\)"/);
  assert.match(install, /url="\$\(json_field "\$meta" dist\.tarball\)"/);
  assert.match(install, /case "\$integrity" in\s*\n\s*sha512-\*\)/);
  assert.match(install, /openssl dgst -sha512 -binary/);
  assert.match(install, /if \[ "\$got" != "\$integrity" \]; then fail 'the downloaded package does not match the registry integrity'/);
});

test('--version is exactly three numeric components, so it cannot walk the registry path', () => {
  assert.match(install, /validate_version\(\)/);
  assert.match(install, /IFS=\. read -r major minor patch extra <<< "\$1"/);
  assert.match(install, /\[ -z "\$extra" \] \|\| fail '--version must be x\.y\.z'/);
  assert.match(install, /case "\$part" in ''\|\*\[!0-9\]\*\) fail '--version must be x\.y\.z'/);
  assert.doesNotMatch(install, /\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*/);
});

test('only the bundle files are installed, from the verified package', () => {
  assert.match(install, /require\(process\.argv\[1\]\)\.AUTHORITY_BUNDLE_FILES/);
  assert.match(install, /lib\/\*\.js\)/);
  assert.match(install, /unexpected bundle path/);
  assert.match(install, /install -m 0644/);
});

test('the state directory belongs to the service user alone', () => {
  assert.match(install, /chown "\$SERVICE_USER:\$SERVICE_USER" "\$STATE_DIR"/);
  assert.match(install, /chmod 0700 "\$STATE_DIR"/);
  assert.match(install, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$STATE_DIR"/);
});

test('the unit hardens the service the way ADR-020 section 3 specifies', () => {
  for (const line of [
    'User=$SERVICE_USER',
    'Group=$SERVICE_USER',
    'Environment=NODE_OPTIONS=',
    'UMask=0077',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ReadWritePaths=$STATE_DIR',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'CapabilityBoundingSet=',
    'RestrictAddressFamilies=AF_INET AF_UNIX',
    'IPAddressDeny=any',
    'IPAddressAllow=localhost',
    'SystemCallFilter=@system-service',
  ]) {
    assert.ok(install.includes(line), `the unit is missing ${line}`);
  }
  assert.match(install, /ExecStart=\$NODE_DIR\/bin\/node \$APP_DIR\/lib\/authority\/service-main\.js serve --state-dir \$STATE_DIR --port \$PORT/);
});

test('the installer refuses ground it did not prepare and sessions that are not root', () => {
  assert.match(install, /already exists; run uninstall-authority\.sh first/);
  assert.match(install, /already exists; remove it \(uninstall-authority\.sh\) and run again/);
  assert.match(install, /\[ "\$\(id -u\)" -eq 0 \] \|\| fail 'run this as root \(sudo\)'/);
  assert.match(install, /--version is required/);
});

test('the installer proves the pinned service answers before it declares success', () => {
  assert.match(install, /systemctl start "\$SERVICE_NAME\.service"/);
  assert.match(install, /createAuthorityClient\(\{pin:p\.pin\}\)\.identity\(\)/);
  assert.match(install, /the service did not answer under the pinned key/);
});

test('the unit is enabled only after enrollment and the identity check succeed', () => {
  // enable is a boot-time commitment: it must follow the proof, not precede it.
  const enableAt = install.indexOf('systemctl enable "$SERVICE_NAME.service"');
  const enrollAt = install.indexOf('key_id="$(invoke_enrollment)"');
  const proofAt = install.indexOf('test_installed "$key_id"');
  assert.ok(enrollAt !== -1 && proofAt !== -1 && enableAt !== -1, 'expected the enroll/proof/enable sequence');
  assert.ok(enrollAt < proofAt && proofAt < enableAt, 'enable must come after enrollment and the proof');
  // The unit writer itself must not enable anything.
  const installUnitBody = install.slice(install.indexOf('install_unit()'), install.indexOf('new_protected_tree()'));
  assert.doesNotMatch(installUnitBody, /systemctl enable/);
});

test('enrollment prompts reach the operator screen even though the caller captures stdout', () => {
  assert.match(install, /\} >&2\n/);
  assert.match(install, /printf 'Enter the 6-digit code your app shows now: ' >&2/);
  assert.match(install, /read -r code < \/dev\/tty/);
  assert.doesNotMatch(install, /read -r -p/);
  // The retry message must go to the terminal too, not into $key_id.
  assert.match(install, /echo 'That code did not match; wait for the next one and try again\.' >&2/);
  assert.match(install, /printf '%s' "\$key_id"\n\s*return 0/);
});

test('the operator window is a root-owned wrapper in the protected install', () => {
  assert.match(install, /wrapper="\$INSTALL_DIR\/huqan-authority-decide"/);
  assert.match(install, /exec "\$NODE_DIR\/bin\/node" "\$APP_DIR\/lib\/authority\/operator-cli\.js"/);
  assert.match(install, /chmod 0755 "\$wrapper"/);
  assert.match(install, /chown root:root "\$wrapper"/);
});

test('the uninstaller renames the state instead of deleting it, and removes the pin', () => {
  assert.match(uninstall, /mv "\$DATA_DIR" "\$archive"/);
  assert.doesNotMatch(uninstall, /rm -rf "\$DATA_DIR"/);
  assert.match(uninstall, /rm -f "\$DATA_DIR\/public\/authority\.json"/);
  assert.match(uninstall, /systemctl disable "\$SERVICE_NAME\.service"/);
  assert.match(uninstall, /rm -rf "\$INSTALL_DIR"/);
});
