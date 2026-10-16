'use strict';

// #2181: the AB8 gate's version, decisions and reasons, the denylist, the
// command wrappers it sees through, raw-disk writers and critical roots.

const AB8_GATE_VERSION = 'AB8-v0.1.0';

const COMMAND_EXEC_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const COMMAND_EXEC_REASONS = Object.freeze({
  ALLOWED: 'ALLOWED',
  EMPTY_COMMAND: 'EMPTY_COMMAND',
  DENYLISTED_COMMAND_BLOCKED: 'DENYLISTED_COMMAND_BLOCKED',
  PATH_OUTSIDE_WORKSPACE_BLOCKED: 'PATH_OUTSIDE_WORKSPACE_BLOCKED',
  SHELL_INJECTION_PATTERN_REVIEW: 'SHELL_INJECTION_PATTERN_REVIEW',
});

// Matched against the raw command text -- known-destructive shapes whose
// signal is the literal text itself, not the argument structure.
const DENYLIST_PATTERNS = Object.freeze([
  { name: 'fork_bomb', pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'pipe_to_shell', pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i },
  { name: 'sudo', pattern: /(^|[;&|]|\s)sudo\s/i },
  { name: 'disk_format', pattern: /\b(mkfs(\.[a-z0-9]+)?|wipefs|shred)\b/i },
  { name: 'chmod_world_writable_root', pattern: /\bchmod\s+(-[a-z]*r[a-z]*\s+)?777\s+(\/|~)(\s|$)/i },
  { name: 'shutdown_or_reboot', pattern: /(^|[;&|]|\s)(shutdown|reboot|halt|poweroff)\b/i },
]);

// ─── Structural (tokenized) denylist checks ─────────────────────────────────
//
// `rm` and raw-disk writes are decided on the *argument structure*, not on a
// single text pattern (#379). The old single regex required the destructive
// flags to sit immediately before a literal `/` or `~`, so every one of these
// walked straight through it:
//
//   rm -rf --no-preserve-root /   flag between the flags and the target
//   rm -rf $HOME                  target is a variable, not `/` or `~`
//   rm -rf $(pwd)                 target is a substitution
//   cp file /dev/sda              raw disk write by a command other than dd
//
// These are decided over tokens instead, so flag order, interleaved flags,
// quoting and the choice of write command no longer matter.

// Wrappers that prefix a real command without changing what it does.
const COMMAND_WRAPPERS = new Set(['sudo', 'doas', 'command', 'time', 'nohup', 'eval', 'exec', 'nice', 'ionice', 'env', 'xargs']);

// Commands that can write to a block device given a path argument.
const RAW_DISK_WRITE_COMMANDS = new Set(['dd', 'cp', 'mv', 'tee', 'cat', 'shred', 'wipefs', 'parted', 'fdisk', 'sgdisk', 'mkfs']);

/**
 * Ways a Unix system actually names a writable block device.
 *
 * The previous expression covered six schemes and missed most of the rest, so
 * `dd of=/dev/xvda` (the root disk of a running EC2 instance) and
 * `dd of=/dev/mapper/vg0-root` (an LVM root volume) were both ALLOW. The
 * `/dev/disk/by-id/…` and `/dev/disk/by-uuid/…` forms matter especially: they
 * are the *recommended* way to name a disk in a script, precisely because
 * `sdX` letters are not stable across boots (#1111).
 */
const RAW_DISK_DEVICE = new RegExp(
  '^/dev/(?:'
  + '(?:sd|hd|vd|xvd)[a-z]+\\d*'      // sda, sda1, xvda, vdb
  + '|nvme\\d+n\\d+(?:p\\d+)?'        // nvme0n1, nvme0n1p1
  + '|mmcblk\\d+(?:p\\d+)?'           // mmcblk0p1
  + '|r?disk\\d+(?:s\\d+)?'           // macOS disk0 / rdisk0s1
  + '|dm-\\d+'                        // device-mapper
  + '|md\\d+(?:p\\d+)?'               // software RAID
  + '|loop\\d+(?:p\\d+)?'             // loop devices
  + '|nbd\\d+(?:p\\d+)?'              // network block devices
  + '|sr\\d+'                         // optical
  + '|mapper/'                        // LVM / LUKS
  + '|disk/'                          // /dev/disk/by-uuid, by-id, by-path
  + ')',
  'i',
);

/**
 * Absolute paths whose recursive removal is never a scoped workspace action.
 *
 * Split in two, because the containment rule differs. Removing anything *under*
 * /etc, /usr or /var is as unscoped as removing the directory itself, so those
 * match their descendants too -- `rm -rf /var/lib` used to be ALLOW because
 * CRITICAL_ROOTS was only ever consulted for an exact match (#1110).
 *
 * The home containers are different: /home and /Users exist to hold ordinary
 * working directories, so a path *under* them is frequently the workspace
 * itself. They match exactly, as before, and nothing deeper.
 */
const CRITICAL_SYSTEM_ROOTS = Object.freeze([
  '/bin', '/sbin', '/boot', '/dev', '/etc', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/srv', '/sys', '/usr', '/var',
  '/Applications', '/Library', '/System',
]);

const CRITICAL_CONTAINER_ROOTS = Object.freeze(['/home', '/Users', '/Volumes']);

const CRITICAL_ROOTS = new Set([
  '/', ...CRITICAL_SYSTEM_ROOTS, ...CRITICAL_CONTAINER_ROOTS,
]);

module.exports = {
  AB8_GATE_VERSION,
  COMMAND_EXEC_DECISIONS,
  COMMAND_EXEC_REASONS,
  COMMAND_WRAPPERS,
  CRITICAL_ROOTS,
  CRITICAL_SYSTEM_ROOTS,
  DENYLIST_PATTERNS,
  RAW_DISK_DEVICE,
  RAW_DISK_WRITE_COMMANDS,
};
