'use strict';

// The agent-user installers cannot run in CI (they need root, a package manager
// or the macOS directory service), so their load-bearing properties are pinned
// here and their syntax is checked by bash itself -- the same pattern
// test/authority-linux-installer-scripts.test.js uses (ADR-020 section 8, #4082
// PR-11).
//
// The property under test is the one the boundary depends on: the marker the
// installer writes must say what lib/authority/agent-user-boundary.js reads, at
// the fixed path that module resolves, and nothing the agent can write may sit
// on that path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { POSIX_STATE_ROOT, POSIX_MARKER_FILENAME, MARKER_VERSION, posixMarkerPath } =
  require('../lib/authority/agent-user-boundary');

const DIR = path.join(__dirname, '..', 'scripts', 'agent-user');
const LINUX = 'install-agent-user-linux.sh';
const DARWIN = 'install-agent-user-darwin.sh';
const SCRIPTS = [LINUX, DARWIN];
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');
// .gitattributes pins LF for these files, but a checkout that ignores it would
// still hand us CRLF; normalise so the multi-line pins below compare content,
// not line-ending style.
const lf = text => text.replace(/\r\n/g, '\n');
const linux = lf(read(LINUX));
const darwin = lf(read(DARWIN));

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

test('each installer writes the marker where the boundary resolves it', () => {
  // The boundary reads a fixed path per platform (ADR-020 section 8); the
  // installer must write exactly that, or the marker is never found.
  assert.equal(posixMarkerPath('linux'), path.posix.join(POSIX_STATE_ROOT.linux, POSIX_MARKER_FILENAME));
  assert.equal(posixMarkerPath('darwin'), path.posix.join(POSIX_STATE_ROOT.darwin, POSIX_MARKER_FILENAME));
  assert.ok(linux.includes(`STATE_ROOT=${POSIX_STATE_ROOT.linux}`));
  assert.ok(linux.includes('MARKER_FILE="$STATE_ROOT/agent-boundary.json"'));
  assert.ok(darwin.includes(`STATE_ROOT=${POSIX_STATE_ROOT.darwin}`));
  assert.ok(darwin.includes('MARKER_FILE="$STATE_ROOT/agent-boundary.json"'));
});

test('the marker carries the version and both uids the boundary reads', () => {
  // The boundary refuses a marker missing agentUid/operatorUid as malformed and
  // refuses a uid that getent/dscl does not confirm, so both fields and the
  // version are load-bearing.
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    assert.ok(text.includes(`MARKER_VERSION=${MARKER_VERSION}`), `${name} pins the wrong version`);
    assert.match(text, /"agentUid":%s/, name);
    assert.match(text, /"operatorUid":%s/, name);
    assert.match(text, /"v":"%s"/, name);
  }
});

test('the operator uid comes from SUDO_UID and a root operator is refused', () => {
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    assert.match(text, /operator_uid="\$SUDO_UID"/, name);
    assert.match(text, /SUDO_UID is unset/, name);
    assert.match(text, /SUDO_UID is 0; the operator must not be root/, name);
    assert.match(text, /SUDO_UID is not a uid/, name);
  }
});

test('the marker is written by root and closed to group and other', () => {
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    assert.match(text, /chmod 0644 "\$tmp"/, name);
    assert.match(text, /mv -f "\$tmp" "\$MARKER_FILE"/, name);
    // The boundary's trust walk refuses any ancestor writable by group or other.
    assert.match(text, /is writable by group or other/, name);
    assert.match(text, /is not owned by root/, name);
    assert.match(text, /is a link/, name);
  }
});

test('the marker path and the operator uid are never taken from the environment', () => {
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    // Only SUDO_UID crosses the boundary; an env variable must not move the
    // evidence (agent-user-boundary.js).
    assert.doesNotMatch(text, /\$\{(?:HOME|USER|TMPDIR|XDG_[A-Z_]+)\}/, name);
    assert.doesNotMatch(text, /STATE_ROOT=\$\{/, name);
    assert.doesNotMatch(text, /MARKER_FILE=\$\{/, name);
  }
});

test('the agent user is never put in an admin group, and an existing admin is refused', () => {
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    // A uid that can become root voids the os-user split (ADR-020 section 9).
    assert.doesNotMatch(text, /usermod -aG|adduser .*sudo|dscl .* -append .* GroupMembership (?:admin|wheel)/, name);
    assert.match(text, /is in (?:sudo\/wheel\/admin|admin\/wheel); remove it there before installing/, name);
  }
});

test('the Linux installer creates a standard user, not a system account', () => {
  assert.match(linux, /useradd --create-home --shell \/bin\/bash "\$AGENT_USER"/);
  assert.doesNotMatch(linux, /useradd --system/);
  assert.match(linux, /getent passwd "\$AGENT_USER" \| cut -d: -f3/);
  assert.match(linux, /\[ "\$\(id -u\)" -eq 0 \] \|\| fail 'run this as root \(sudo\)'/);
});

test('the macOS installer creates a hidden normal user under /Library, not /var', () => {
  // /var is a symlink into /private on macOS, which would break the runtime's
  // "no link on the path" rule (ADR-020 section 1).
  assert.ok(darwin.includes(`STATE_ROOT=${POSIX_STATE_ROOT.darwin}`));
  assert.doesNotMatch(darwin, /^\w+_ROOT=\/(var|etc|usr\/local)\//m);
  assert.match(darwin, /dscl \. -create "\/Users\/\$AGENT_USER" UniqueID "\$uid"/);
  assert.match(darwin, /dscl \. -create "\/Users\/\$AGENT_USER" IsHidden 1/);
  assert.match(darwin, /UID_FLOOR=501/);
  assert.match(darwin, /dscl \. -read "\/Users\/\$AGENT_USER" UniqueID \| awk/);
});

test('the installer proves the tree is root-owned before it declares success', () => {
  // assert_protected must run after the marker is written and before the final
  // message, so a mis-owned file fails the install rather than being reported
  // as installed.
  for (const [name, text] of [[LINUX, linux], [DARWIN, darwin]]) {
    const assertAt = text.lastIndexOf('assert_protected');
    const writeAt = text.lastIndexOf('write_marker');
    assert.ok(writeAt !== -1 && assertAt !== -1, `${name} is missing the write/assert sequence`);
    assert.ok(writeAt < assertAt, `${name} must assert after writing the marker`);
  }
});
