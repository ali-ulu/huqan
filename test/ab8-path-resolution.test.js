'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateCommandExec } = require('../lib/command-exec-gate');

const WORKSPACE_ROOT = '/tmp/ws';

function evaluate(command) {
  return evaluateCommandExec({
    command,
    workspaceRoot: WORKSPACE_ROOT,
    metadata: { workspaceId: 'default' },
  });
}

function assertBlocked(command, reason, message) {
  const result = evaluate(command);
  assert.equal(result.decision, 'block', `${command} must be blocked${message ? ` -- ${message}` : ''}`);
  assert.equal(result.reason, reason, `${command} must be blocked for ${reason}`);
}

function assertAllowed(command) {
  const result = evaluate(command);
  assert.equal(result.decision, 'allow', `${command} is an ordinary command and must stay allowed`);
  assert.equal(result.reason, 'ALLOWED');
}

const DENYLISTED = 'DENYLISTED_COMMAND_BLOCKED';
const OUT_OF_WORKSPACE = 'PATH_OUTSIDE_WORKSPACE_BLOCKED';

test('#1110 every spelling of the root directory is blocked, not just the literal one', () => {
  // Each of these removes the contents of `/` exactly as `rm -rf /` does. The
  // gate used to compare the raw token against a literal set, so only the two
  // spellings that happened to be in the set matched.
  for (const target of ['/', '///', '\\/', '/.', '/./', '/etc/..', '/home/../', '/usr/../']) {
    assertBlocked(`rm -rf ${target}`, DENYLISTED, `${target} resolves to /`);
  }
});

test('#1110 a critical system root protects what is under it too', () => {
  // CRITICAL_ROOTS was consulted only for an exact match, so one level down was
  // allowed -- and removing /var/lib recursively is no more scoped than
  // removing /var.
  for (const target of ['/var/lib', '/usr/local', '/etc/ssh', '/boot/efi', '/lib/systemd']) {
    assertBlocked(`rm -rf ${target}`, DENYLISTED, `${target} is under a critical root`);
  }
});

test('#1110 the shapes that already blocked still block', () => {
  for (const command of [
    'rm -rf /',
    'rm -rf "/"',
    'rm -rf /*',
    'rm -rf $HOME',
    'rm -rf / --no-preserve-root',
    'rm -rf ~',
    'sudo rm -rf /',
  ]) {
    assert.equal(evaluate(command).decision, 'block', `${command} must stay blocked`);
  }
});

test('#1111 the raw-device inventory covers how disks are actually named', () => {
  const devices = [
    ['/dev/sda', 'classic SCSI/SATA'],
    ['/dev/nvme0n1', 'NVMe'],
    ['/dev/xvda', 'AWS EC2 / Xen root device'],
    ['/dev/mapper/vg0-root', 'LVM / LUKS'],
    ['/dev/dm-0', 'device-mapper'],
    ['/dev/md0', 'software RAID'],
    ['/dev/loop0', 'loop device'],
    ['/dev/nbd0', 'network block device'],
    ['/dev/rdisk0', 'macOS raw disk'],
    ['/dev/disk/by-uuid/abc', 'persistent naming -- the recommended form in scripts'],
    ['/dev/disk/by-id/wwn-0x5', 'persistent naming'],
    ['/dev/./sda', 'the same file as /dev/sda'],
  ];

  for (const [device, why] of devices) {
    assertBlocked(`dd if=/dev/zero of=${device}`, DENYLISTED, why);
    // Not just dd: the gate covers every write-capable command.
    assertBlocked(`cat payload > ${device}`, DENYLISTED, why);
  }
});

test('#1145 a write-command destination outside the workspace is blocked, not only a redirection', () => {
  for (const command of [
    'cp secret /etc/passwd',
    'mv payload /etc/cron.d/backdoor',
    'tee /etc/cron.d/backdoor',
    'install -m 644 evil /etc/systemd/system/unit.service',
    'touch /etc/nologin',
    'mkdir /etc/evil',
    'ln -s /etc/shadow /etc/shadow.bak',
    'dd if=payload of=/etc/hosts',
  ]) {
    assertBlocked(command, OUT_OF_WORKSPACE, 'the destination is outside the workspace root');
  }

  // The promise that already held.
  assertBlocked('cat x > /etc/passwd', OUT_OF_WORKSPACE);
});

test('ordinary commands are not caught by any of the widened checks', () => {
  for (const command of [
    'ls',
    'npm test',
    'cp a.txt b.txt',
    'mkdir -p src/lib',
    'touch src/new.js',
    'echo hi > out.txt',
    'rm -rf node_modules',
    'rm -rf ./build',
    `rm -rf ${WORKSPACE_ROOT}/tmp`,
    'dd if=/dev/zero of=./disk.img',
    // Reads from outside the workspace write *into* it -- collecting every
    // operand rather than the destination would have turned this into a block.
    'cp /etc/hosts ./local-hosts',
    'tee ./log.txt',
  ]) {
    assertAllowed(command);
  }
});

test('a destination behind an unresolved expansion is not reported as a containment breach', () => {
  // The gate cannot know where "$OUT" points. Treating that as out-of-workspace
  // would block ordinary in-workspace commands; removals still fail closed on
  // expansions through their own check, which the last assertion pins.
  assert.equal(evaluate('cp a.txt "$OUT/b.txt"').decision, 'allow');
  assert.equal(evaluate('rm -rf "$OUT"').decision, 'block');
});
