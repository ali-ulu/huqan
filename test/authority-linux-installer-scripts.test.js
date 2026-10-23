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

test('--tarball installs a locally built package and checks it against --integrity', () => {
  // CI runs `npm pack` and installs that file; the trust decision is the same
  // sha512 check, only its source changes (ADR-020 open question 4).
  assert.match(install, /if \[ -n "\$TARBALL" \]; then/);
  assert.match(install, /case "\$INTEGRITY" in\s*\n\s*sha512-\*\)/);
  assert.match(install, /cp "\$TARBALL" "\$tarball"/);
  assert.match(install, /integrity="\$INTEGRITY"/);
  assert.match(install, /--tarball needs --integrity sha512-<base64>/);
  // Without --tarball the registry path is unchanged: no `sha512-` case that
  // would accept an empty integrity.
  assert.match(install, /curl -fsSL "\$REGISTRY\/\$VERSION" -o "\$meta"/);
});

test('--integrity without --tarball is refused rather than silently ignored', () => {
  assert.match(install, /if \[ -z "\$TARBALL" \] && \[ -n "\$INTEGRITY" \]; then fail '--integrity is only used with --tarball'; fi/);
  // A --tarball with no integrity would otherwise read as a verified install.
  assert.match(install, /if \[ -n "\$TARBALL" \] && \[ -z "\$INTEGRITY" \]; then fail '--tarball needs --integrity sha512-<base64>'; fi/);
});

test('--enroll-code-stdin reads the code from stdin instead of the terminal', () => {
  // A CI runner has no controlling terminal, so `/dev/tty` cannot be opened.
  assert.match(install, /--enroll-code-stdin\) ENROLL_FROM_STDIN=1; shift ;;/);
  assert.match(install, /if \[ "\$ENROLL_FROM_STDIN" = 1 \]; then\s*\n(?:\s*#.*\n)*\s*read -r code \|\| fail 'stdin closed before an enrollment code was read'/);
  assert.match(install, /read -r code < \/dev\/tty/);
});

test('a closed stdin aborts enrollment instead of spending the attempts on empty codes', () => {
  // EOF is an input failure, not a wrong code: looping it would record TOTP
  // failures in totp-progress.json and change enrollment state (CodeRabbit on #4156).
  assert.doesNotMatch(install, /read -r code \|\| code=/);
  assert.match(install, /read -r code \|\| fail 'stdin closed before an enrollment code was read'/);
});

test('--tarball is validated before the installer changes system state', () => {
  // A mistyped path must fail before ensure_service_user and new_protected_tree,
  // or it leaves an account and a data tree that make the next install fail
  // assert_fresh (CodeRabbit on #4156).
  assert.match(install, /if \[ -n "\$TARBALL" \] && \[ ! -f "\$TARBALL" \]; then fail "--tarball is not a regular file: \$TARBALL"; fi/);
  const checkAt = install.indexOf('--tarball is not a regular file');
  // lastIndexOf finds the call in main(), not the earlier definition.
  assert.ok(checkAt < install.lastIndexOf('new_protected_tree'), 'the check must precede the new_protected_tree call');
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

test('the verified node tree is normalised to root, so the executed binary is not uid-writable (#4228)', () => {
  // cp -a preserves the tarball's uid (1000 on linux-x64, 1001 on linux-arm64),
  // leaving NODE_DIR/bin/node -- the binary the unit ExecStart and the decide
  // wrapper both execute -- writable by an ordinary local account. The darwin
  // installer already normalises; this pins the Linux equivalent.
  assert.match(
    install,
    /cp -a "\$staging\/\$extract_dir\/\." "\$NODE_DIR\/"\n\s*(?:#.*\n\s*)*chown -R root:root "\$INSTALL_DIR"\n\s*chmod -R go-w "\$INSTALL_DIR"\n\s*chmod 0755 "\$INSTALL_DIR" "\$NODE_DIR"/,
  );
});

test('the app directory mode is pinned instead of inheriting the umask (#4228)', () => {
  assert.match(
    install,
    /mkdir -p "\$APP_DIR\/\$\(dirname "\$rel"\)"\n\s*(?:#.*\n\s*)*chmod 0755 "\$APP_DIR" "\$APP_DIR\/\$\(dirname "\$rel"\)"/,
  );
});

test('the install tree is asserted root-owned, like the darwin installer (#4228)', () => {
  assert.match(install, /for target in "\$INSTALL_DIR" "\$APP_DIR" "\$NODE_DIR" "\$NODE_DIR\/bin\/node" "\$DATA_DIR" "\$PUBLIC_DIR" "\$PIN_FILE"; do/);
});

test('the unit hardens the service the way ADR-020 section 3 specifies', () => {
  for (const line of [
    'User=$SERVICE_USER',
    'Group=$SERVICE_USER',
    'Environment=NODE_OPTIONS=',
    'UMask=0077',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
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
  // The exec line and ReadWritePaths are built from a variable so the socket
  // transport can add to them; the TCP default must still be the bare state
  // directory (ADR-020 section 12).
  assert.match(install, /exec_line="ExecStart=\$NODE_DIR\/bin\/node \$APP_DIR\/lib\/authority\/service-main\.js serve --state-dir \$STATE_DIR --port \$PORT"/);
  assert.match(install, /rw_paths="\$STATE_DIR"/);
  assert.match(install, /^ReadWritePaths=\$rw_paths$/m);
  // With --socket the exec line names the socket and the run directory is
  // writable, or ProtectSystem=strict turns the bind into EROFS.
  assert.match(install, /exec_line="\$exec_line --socket \$SOCKET_PATH"/);
  assert.match(install, /rw_paths="\$STATE_DIR \$RUN_DIR"/);
});

test('--socket creates the operator group and the socket directory', () => {
  // ADR-020 section 12: the installer side creates the group, the directory and
  // the pin field; the bundle only carries the transport.
  assert.match(install, /--socket\) USE_SOCKET=1; shift ;;/);
  assert.match(install, /SOCKET_GROUP=huqan-authority-ops/);
  assert.match(install, /RUN_DIR="\$DATA_DIR\/run"/);
  assert.match(install, /SOCKET_PATH="\$RUN_DIR\/authority\.sock"/);
  // The operator is the caller, carried across sudo as SUDO_UID, and a root
  // operator is refused (the same rule the agent-user installer follows).
  assert.match(install, /if \[ -z "\$\{SUDO_UID:-\}" \]; then fail 'SUDO_UID is unset/);
  assert.match(install, /SUDO_UID is 0; the operator must not be root/);
  assert.match(install, /SUDO_UID is not a uid/);
  // The group is created only if absent, and the membership edit only adds.
  assert.match(install, /if ! getent group "\$SOCKET_GROUP" >\/dev\/null; then groupadd --system "\$SOCKET_GROUP"; fi/);
  assert.match(install, /usermod -aG "\$SOCKET_GROUP"/);
  // The socket directory is service-user-owned, group-owned by the operator
  // group, mode 2750 (setgid so the socket inherits the group).
  assert.match(install, /chown "\$SERVICE_USER:\$SOCKET_GROUP" "\$RUN_DIR"/);
  assert.match(install, /chmod 2750 "\$RUN_DIR"/);
});

test('the group and the socket directory exist before the unit is written', () => {
  // The unit names them, so creating them after install_unit would leave a
  // service that cannot bind.
  const groupAt = install.lastIndexOf('ensure_socket_group');
  const runDirAt = install.lastIndexOf('ensure_run_dir');
  const unitAt = install.lastIndexOf('install_unit');
  assert.ok(groupAt !== -1 && runDirAt !== -1 && unitAt !== -1, 'expected the group/run-dir/unit sequence');
  assert.ok(groupAt < unitAt && runDirAt < unitAt, 'the group and run directory must precede install_unit');
});

test('the pin names the socket only when --socket was given', () => {
  assert.match(install, /if \[ "\$USE_SOCKET" = 1 \]; then\s*\n\s*"\$node" "\$service_main" init --state-dir "\$STATE_DIR" --public-dir "\$PUBLIC_DIR" --port "\$PORT" --socket "\$SOCKET_PATH"/);
  // Without --socket the init line is unchanged: no socket in the pin.
  assert.match(install, /"\$node" "\$service_main" init --state-dir "\$STATE_DIR" --public-dir "\$PUBLIC_DIR" --port "\$PORT" > "\$init"/);
});

test('the socket and its directory are asserted to be 0660 and 2750 after the proof', () => {
  assert.match(install, /if \[ "\$USE_SOCKET" = 1 \]; then assert_socket_protected; fi/);
  assert.match(install, /\[ ! -S "\$SOCKET_PATH" \]/);
  assert.match(install, /\[ "\$sock_group" != "\$SOCKET_GROUP" \]/);
  assert.match(install, /\[ "\$sock_mode" != 432 \]/);
  assert.match(install, /\[ "\$dir_mode" != 1512 \]/);
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
  // The socket file goes before the tree is archived, so a reinstall cannot
  // find a leftover socket at the path it is about to bind.
  assert.match(uninstall, /rm -f "\$DATA_DIR\/run\/authority\.sock"/);
  // The operator group is left behind, like the service user, and named for a
  // hand removal: the uninstaller never deletes it itself.
  assert.match(uninstall, /SOCKET_GROUP=huqan-authority-ops/);
  assert.doesNotMatch(uninstall, /^\s*groupdel/m);
  assert.match(uninstall, /The operator group \$SOCKET_GROUP was left in place/);
});
