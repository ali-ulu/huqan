'use strict';

// The macOS installer cannot run in CI (it needs root, launchd and dscl), so its
// load-bearing properties are pinned here and its syntax is checked by bash
// itself -- the same pattern test/authority-linux-installer-scripts.test.js uses
// for the Linux pair (ADR-020 sections 1-3, #4082 PR-5).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { posixAuthorityLayout } = require('../lib/authority/posix-path-trust');

const DIR = path.join(__dirname, '..', 'scripts', 'authority');
const SCRIPTS = ['install-authority-darwin.sh', 'uninstall-authority-darwin.sh'];
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// .gitattributes pins LF for these files, but a checkout that ignores it would
// still hand us CRLF; normalise so the multi-line pins below compare content,
// not line-ending style.
const lf = text => text.replace(/\r\n/g, '\n');
const install = lf(read('install-authority-darwin.sh'));
const uninstall = lf(read('uninstall-authority-darwin.sh'));

test('the scripts are pure ASCII, because a non-UTF-8 locale would misread anything else', () => {
  for (const name of SCRIPTS) {
    const offending = [...read(name)].findIndex(ch => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
    assert.equal(offending, -1, `${name} has a non-ASCII character at ${offending}`);
  }
});

// The script text goes in on stdin, not as a path: on Windows `bash` may be the
// WSL stub, which eats a native `C:\...` argument.
test('bash parses both scripts', () => {
  for (const name of SCRIPTS) {
    const run = spawnSync('bash', ['-n'], { input: lf(read(name)), encoding: 'utf8' });
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
});

test('the installer writes exactly where the runtime looks, and takes no path from the environment', () => {
  const layout = posixAuthorityLayout('darwin');
  assert.ok(install.includes(`INSTALL_DIR=${layout.installDir}`));
  assert.ok(install.includes(`DATA_DIR=${layout.dataDir}`));
  assert.ok(install.includes(`SERVICE_USER=${layout.serviceUser}`));
  // The resolver's fixed pin path is the one the service writes.
  assert.ok(install.includes('PIN_FILE="$PUBLIC_DIR/authority.json"'));
  assert.equal(path.posix.join(layout.dataDir, 'public', 'authority.json'), layout.pinPath);
  assert.doesNotMatch(install, /\$\{(?:HOME|USER|TMPDIR|XDG_[A-Z_]+)\}/);
  assert.doesNotMatch(install, /INSTALL_DIR=\$\{/);
});

test('every path lives under /Library, never /usr/local or a symlinked root', () => {
  // /var and /etc are symlinks into /private on macOS, which would break the
  // runtime's "no link on the path" rule; Homebrew can hand /usr/local to the
  // user (ADR-020 section 1).
  assert.ok(install.includes('INSTALL_DIR=/Library/HUQAN/authority'));
  assert.ok(install.includes('DATA_DIR=/Library/HUQAN/authority-data'));
  assert.ok(install.includes('LOG_DIR=/Library/Logs/HUQAN'));
  assert.ok(install.includes('PLIST_FILE="/Library/LaunchDaemons/$SERVICE_LABEL.plist"'));
  assert.doesNotMatch(install, /^\w+_DIR=\/(var|etc|usr\/local)\//m);
});

test('node is verified against the GPG-signed manifest, with no unverified path', () => {
  assert.ok(install.includes('NODE_KEYRING_URL=https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx'));
  assert.match(install, /SHASUMS256\.txt\.asc/);
  assert.match(install, /gpg --batch --no-default-keyring --keyring[\s\S]*?--decrypt/);
  assert.match(install, /shasum -a 256 -c -/);
  assert.match(install, /MIN_NODE=22\.13\.0/);
  assert.doesNotMatch(install, /allow-unverified-node/);
  // The Linux sha256sum and base64 -w0 do not exist on macOS.
  assert.doesNotMatch(install, /sha256sum/);
  assert.doesNotMatch(install, /base64 -w0/);
});

test('the node tarball is the darwin build for the host architecture, not a hardcoded x64', () => {
  assert.match(install, /x86_64\|amd64\) printf '%s' x64/);
  assert.match(install, /arm64\|aarch64\) printf '%s' arm64/);
  assert.match(install, /\*\) fail "unsupported architecture: \$\(uname -m\)"/);
  assert.match(install, /tarball="node-v\$\{ver\}-darwin-\$\{arch\}\.tar\.gz"/);
  assert.match(install, /extract_dir="node-v\$\{ver\}-darwin-\$\{arch\}"/);
  assert.doesNotMatch(install, /darwin-x64\.tar\.gz/);
  assert.doesNotMatch(install, /linux-\$\{arch\}/);
});

test('the verified node is re-owned to root, because the tarball records uid 501', () => {
  // node-v22.23.3-darwin-arm64.tar.gz stores 501/20, and cp -a would carry that
  // onto the target: a uid that exists there could then replace the node the
  // daemon execs.
  assert.match(install, /cp -a "\$staging\/\$extract_dir\/\." "\$NODE_DIR\/"\n\s*chown -R root:wheel "\$NODE_DIR"\n\s*chmod -R go-w "\$NODE_DIR"/);
});

test('every chown names the wheel group, because macOS has no root group', () => {
  // On macOS group 0 is wheel; `chown root:root` fails with "illegal group
  // name", which `set -e` turns into a dead installer on every host.
  const chowns = install.match(/^\s*chown[^\n]*$/gm) || [];
  assert.ok(chowns.length > 0, 'expected chown calls');
  for (const line of chowns) {
    assert.doesNotMatch(line, /:root\b/, `macOS has no root group: ${line.trim()}`);
  }
  assert.match(install, /chown root:wheel "\$DATA_DIR" "\$PUBLIC_DIR"/);
  assert.match(install, /chown root:wheel "\$PLIST_FILE"/);
  assert.match(install, /chown root:wheel "\$wrapper"/);
});

test('the protected-path check covers the program and the node, not only the data', () => {
  assert.match(install, /for target in "\$DATA_DIR" "\$PUBLIC_DIR" "\$PIN_FILE" "\$INSTALL_DIR" "\$NODE_DIR" "\$APP_DIR"; do/);
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
  // macOS has no base64 -w0; the digest stays on one line through -A.
  assert.match(install, /openssl base64 -A/);
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

test('the service user is hidden, below uid 500 and unable to log in', () => {
  // dscl, not useradd: the account is a hidden system user with a shell that
  // cannot log in (ADR-020 section 1).
  assert.match(install, /dscl \. -create "\/Users\/\$SERVICE_USER"/);
  assert.match(install, /dscl \. -create "\/Users\/\$SERVICE_USER" UserShell \/usr\/bin\/false/);
  assert.match(install, /dscl \. -create "\/Users\/\$SERVICE_USER" IsHidden 1/);
  assert.match(install, /dscl \. -create "\/Users\/\$SERVICE_USER" NFSHomeDirectory \/var\/empty/);
  // The uid search must stay under 500, and refuse rather than climb above it.
  assert.match(install, /local id=499/);
  assert.match(install, /while \[ "\$id" -ge 400 \]/);
  assert.match(install, /fail "no free \$1 id below 500"/);
  // Reuse an existing account so a reinstall keeps the uid the state is owned by.
  assert.match(install, /if dscl \. -read "\/Users\/\$SERVICE_USER" >\/dev\/null 2>&1; then return 0; fi/);
  assert.doesNotMatch(install, /useradd/);
});

test('the plist names the service user and is installed root:wheel 0644', () => {
  assert.ok(install.includes('SERVICE_LABEL=com.huqan.authority'));
  assert.match(install, /<key>UserName<\/key>\s*\n\s*<string>\$SERVICE_USER<\/string>/);
  assert.match(install, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/);
  assert.match(install, /<key>KeepAlive<\/key>\s*\n\s*<true\/>/);
  // The empty NODE_OPTIONS mirrors the Windows WinSW definition and the Linux
  // unit (ADR-020 section 3).
  assert.match(install, /<key>NODE_OPTIONS<\/key>\s*\n\s*<string><\/string>/);
  // Umask 63 is octal 0077.
  assert.match(install, /<key>Umask<\/key>\s*\n\s*<integer>63<\/integer>/);
  assert.match(install, /<key>StandardErrorPath<\/key>\s*\n\s*<string>\$LOG_FILE<\/string>/);
  assert.match(install, /chown root:wheel "\$PLIST_FILE"/);
  assert.match(install, /chmod 0644 "\$PLIST_FILE"/);
  assert.match(install, /plutil -lint "\$PLIST_FILE"/);
  // The arguments are the same serve command the Linux unit runs.
  assert.match(install, /<string>serve<\/string>\s*\n\s*<string>--state-dir<\/string>\s*\n\s*<string>\$STATE_DIR<\/string>\s*\n\s*<string>--port<\/string>\s*\n\s*<string>\$PORT<\/string>/);
});

test('the installer refuses ground it did not prepare and sessions that are not root', () => {
  assert.match(install, /already exists; run uninstall-authority-darwin\.sh first/);
  assert.match(install, /already exists; remove it \(uninstall-authority-darwin\.sh\) and run again/);
  assert.match(install, /\[ "\$\(id -u\)" -eq 0 \] \|\| fail 'run this as root \(sudo\)'/);
  assert.match(install, /--version is required/);
  assert.match(install, /command -v launchctl >\/dev\/null \|\| fail 'launchd is required'/);
});

test('the installer proves the pinned service answers before it declares success', () => {
  assert.match(install, /launchctl bootstrap system "\$PLIST_FILE"/);
  assert.match(install, /createAuthorityClient\(\{pin:p\.pin\}\)\.identity\(\)/);
  assert.match(install, /the service did not answer under the pinned key/);
});

test('the boot-time commitment follows the proof, and a failure leaves no plist behind', () => {
  // The macOS counterpart of "enable the unit last": the plist is what launchd
  // loads at every boot, so the cleanup trap must remove it on any failure.
  const proofAt = install.indexOf('test_installed "$key_id"');
  const bootstrapAt = install.indexOf('launchctl bootstrap system "$PLIST_FILE"');
  assert.ok(proofAt !== -1 && bootstrapAt !== -1, 'expected the proof/bootstrap sequence');
  assert.ok(bootstrapAt < proofAt, 'bootstrap must come before the proof');
  // The plist writer itself must not bootstrap anything.
  const installPlistBody = install.slice(install.indexOf('install_plist()'), install.indexOf('new_protected_tree()'));
  assert.doesNotMatch(installPlistBody, /launchctl bootstrap/);
  // The failure path boots the daemon out and removes the plist.
  assert.match(install, /launchctl bootout "system\/\$SERVICE_LABEL" >\/dev\/null 2>&1 \|\| true\s*\n\s*rm -f "\$PLIST_FILE"/);
  assert.match(install, /if \[ "\$status" -ne 0 \] && \[ -e "\$PLIST_FILE" \]; then/);
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
  assert.match(install, /chown root:wheel "\$wrapper"/);
});

test('the ownership assertions read macOS stat, which has no -c', () => {
  assert.match(install, /stat -f '%u' "\$1"/);
  assert.match(install, /stat -f '%Lp' "\$1"/);
  assert.doesNotMatch(install, /stat -c/);
  // The state directory must be owned by a non-root service user, mode 0700.
  assert.match(install, /if \[ "\$\(owner_uid "\$STATE_DIR"\)" = 0 \] \|\| \[ "\$\(file_mode "\$STATE_DIR"\)" != 448 \]; then/);
});

test('the uninstaller boots the daemon out, renames the state instead of deleting it, and removes the pin', () => {
  assert.match(uninstall, /launchctl bootout "system\/\$SERVICE_LABEL"/);
  assert.match(uninstall, /mv "\$DATA_DIR" "\$archive"/);
  assert.doesNotMatch(uninstall, /rm -rf "\$DATA_DIR"/);
  assert.match(uninstall, /rm -f "\$DATA_DIR\/public\/authority\.json"/);
  assert.match(uninstall, /rm -f "\$PLIST_FILE"/);
  assert.match(uninstall, /rm -rf "\$INSTALL_DIR"/);
  // Deleting the service user would orphan the renamed state; it is left alone.
  assert.doesNotMatch(uninstall, /dscl \. -delete/);
});
