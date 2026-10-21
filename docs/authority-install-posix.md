# Approval Authority on Linux and macOS

This document is the operator guide for the POSIX Approval Authority (ADR-020,
issue #4082). It covers what the boundary gives you, how to install it on Linux
(systemd) and macOS (launchd), how to enroll the operator, how to decide an
approval, how to read `status` and `doctor`, and how to remove it. It ends with
the non-claims: the list of things this boundary does not promise.

Windows has its own installer and is out of scope here; see
[ADR-016](./adr/ADR-016-approval-authority-os-boundary.md) and
`scripts/authority/install-authority.ps1`.

## What the boundary is

The approval authority moves the decision that admits a protected action out of
the agent's process and into a service running under its own OS user. The
service holds the Ed25519 signing key and the operator's TOTP secret in a
directory the agent cannot read, so code running as the agent's user cannot
produce a valid decision envelope even if it edits the runtime.

Two layers are involved (ADR-020):

- **Layer A, `boundary: os-service`** - the authority is a service under a
  separate system user. This is the layer that closes the original gap.
- **Layer B, `agentBoundary: os-user`** - the agent runs as its own user and
  cannot reach the protected store at the file level. It builds on Layer A and
  is tracked separately (PR-9 to PR-11).

## Requirements

- Linux with systemd and glibc, or macOS with launchd.
- `root` for the install and the uninstall. The installer refuses `euid != 0`.
- `gpg` on Linux, to verify the node tarball against the GPG-signed
  `SHASUMS256.txt`. macOS uses the same signed checksums.
- A Huqan version that ships the authority bundle (`--version <x.y.z>`).

Containers, VMs and remote hosts are not supported in this MVP. On an
unsupported platform the resolver fails closed rather than falling back to
`legacy`.

## Paths

The installer writes fixed paths; none of them is taken from the environment.

| Role | Linux | macOS | Owner / mode |
|---|---|---|---|
| Service user | `huqan-authority` | `_huqanauthority` (uid < 500, hidden) | - |
| Code (node + bundle) | `/opt/huqan-authority/{node,app}` | `/Library/HUQAN/authority/{node,app}` | root, dirs 0755, node 0755 |
| Data root | `/var/lib/huqan-authority` | `/Library/HUQAN/authority-data` | root, 0755 |
| `public/authority.json` (pin) | `<data>/public/` | same | root, dir 0755, pin 0644 |
| `state/` | `<data>/state` | same | service user, **0700**, files 0600 |
| Log | journald | `/Library/Logs/HUQAN/authority.log` | service user, 0750 |
| Service definition | `/etc/systemd/system/huqan-authority.service` | `/Library/LaunchDaemons/com.huqan.authority.plist` | root, 0644 |

## Install

### Linux (systemd)

```bash
sudo scripts/authority/install-authority.sh --version 1.0.2
```

### macOS (launchd)

```bash
sudo scripts/authority/install-authority-darwin.sh --version 1.0.2
```

Both take the same flags:

- `--version <x.y.z>` (required) - the Huqan version whose bundle is installed.
- `--node-version v22.23.3` - the node build to fetch and verify (default).
- `--port 47821` - the loopback port the service listens on (default).
- `--tarball <path> --integrity <sha512-...>` - install from a local tarball
  instead of the registry. Both are required together: `--integrity` without
  `--tarball` is refused rather than ignored, and `--tarball` without
  `--integrity` is refused rather than trusted.
- `--enroll-code-stdin` - read the enrollment code from stdin instead of the
  terminal. This is for CI; a human should use the terminal prompt.

The installer validates `--tarball` **before** it creates the service account or
the data tree, so a mistyped path fails without leaving half an install behind.

What it does, in order: refuse unless `euid` is 0; refuse if the install or data
directory already exists; create the service user; create the protected tree;
fetch and verify node; fetch and verify the package; install the bundle; write
the service definition; enroll the operator; test identity under the pinned key;
verify the runtime path trust; and only then enable the service. Enabling last
means a failure earlier leaves nothing that starts at the next boot with
unconfirmed state.

### Enrollment

Enrollment is where the operator's TOTP secret is written. Do it with agents
stopped: the code appears on the terminal, and anything running as the operator
could read it (ADR-016 risk 4). The installer prompts on the terminal. Under
`--enroll-code-stdin` it reads the code from stdin; an immediate end of input
aborts before the first check, so a failed run does not spend an attempt or
change enrollment state.

## Decide an approval

Decisions are made through the elevated wrapper, not the agent's process:

```bash
sudo /opt/huqan-authority/huqan-authority-decide
```

On macOS the wrapper is under `/Library/HUQAN/authority/`. The window is
elevated (`SLDF_RUNAS_USER` on Windows; `sudo` on POSIX) so the operator types
the TOTP code where the agent cannot watch the same session.

## Check the runtime

```bash
node bin/huqan-authority.js status
```

After a successful install the report has `mode: "service"`,
`boundary: "os-service"` and `answering: true`, and it names the port and the
pinned `keyId`. It also carries `escalation`, which is described below.

`huqan doctor` has an `Approval authority` line:

```bash
node cli.js doctor
```

It passes with a note when no authority is installed (`legacy`, the documented
default). It fails only when the boundary is claimed and does not hold: an
authority that is required but unavailable, a pinned service that does not
answer under its own key, or an `os-service` boundary the runtime user can
`sudo` past. See ADR-020 section 11.

### `escalation`

`os-service` is not absolute protection. A runtime user with passwordless
`sudo` can become root and read the TOTP secret, so the state is reported rather
than assumed to hold. The `escalation` field is set on every mode and answers
what a fixed, non-interactive `sudo -n true` probe observed:

| Value | Meaning |
|---|---|
| `passwordless_sudo` | the probe ran `sudo` without a password prompt |
| `none` | the probe ran and `sudo` refused without a password |
| `unknown` | the probe could not run; escalation is unverified |
| `not_applicable` | not Linux or macOS |

The value is named for what the probe saw, not for a sudoers configuration it
cannot see. A successful probe can come from a cached credential as well as a
`NOPASSWD` rule, and a failed probe can hide a narrow `NOPASSWD` rule for one
other command. On an `os-service` boundary a `passwordless_sudo` result fails
the doctor check; on an `env-override` pin it is reported but does not fail,
because that pin claims no OS boundary.

## Troubleshooting: reason to fix

When the resolver does not reach `service`, `status` reports a `reason`. The
same vocabulary is used on Windows.

| Reason | Meaning | Fix |
|---|---|---|
| `no_pin` | no installed pin, and none supplied | install the authority, or supply a pin |
| `pin_unreadable` | the pin exists but could not be read | check ownership and mode on `public/authority.json` |
| `install_path_linked` | a component of the install path is a symlink | remove the link; install on a real path |
| `install_path_untrusted` | a component is not root-owned, or is group/other-writable | `chown root` and `chmod go-w` the path |
| `state_dir_exposed` | the state directory is not 0700 or not owned by the service user | fix ownership and mode on `state/` |
| `container_unverified` | a container was detected | not supported in the MVP |

A pin on a path with a symlink, a non-root owner, group/other write bits, or a
macOS extended ACL resolves to `required_unavailable`, never to `legacy`. The
runtime never falls back to `legacy` while an installed pin exists, and no
environment variable can lower the mode or replace the pin.

## Uninstall

```bash
sudo scripts/authority/uninstall-authority.sh          # Linux
sudo scripts/authority/uninstall-authority-darwin.sh   # macOS
```

The uninstaller stops and removes the service, removes the service user, and
removes the pin. The CI end-to-end test asserts that no unit, user or pin
remains afterward.

## Non-claims

Carried verbatim from ADR-020:

- No guarantee against an agent that has root or passwordless sudo.
- No guarantee against a kernel exploit or against a shared kernel (ADR-017
  risk 1).
- Containers, VMs and remote hosts are not supported in the MVP.
- SIP, TCC, AppArmor and SELinux are not relied upon.
- Layer A alone does not prevent a runtime bypass; it only makes it detectable.
- The caller's uid is not verified.
- TOTP proves the operator is present, not what the operator intended (ADR-016
  risk 2).
- Sudoers rules added after install are visible only when `doctor` runs as root.

## See also

- [ADR-016](./adr/ADR-016-approval-authority-os-boundary.md) - the OS boundary.
- [ADR-017](./adr/ADR-017-agent-user-boundary.md) - the agent-user boundary.
- [ADR-020](./adr/ADR-020-posix-authority-parity.md) - Linux/macOS parity.
- [install-30min.md](./install-30min.md) - the full gate, authority and receipt
  walkthrough.
