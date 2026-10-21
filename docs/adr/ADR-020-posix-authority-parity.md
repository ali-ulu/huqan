# ADR-020: POSIX parity for the approval authority (Linux and macOS)

- **Status:** Accepted (open questions 5, 6 and 7 stay open, see the last section)
- **Date:** 2026-10-20
- **Deciders:** repository owner
- **Supersedes:** none
- **Cross-references:** #4082 (this decision, PR-0), [ADR-016 approval authority behind an OS boundary](ADR-016-approval-authority-os-boundary.md), [ADR-017 agents run as a separate OS user and session](ADR-017-agent-user-boundary.md) (residual risk 2, "Non-Windows parity"), [ADR-018 agent boundary decisions](ADR-018-agent-boundary-decisions.md)
- **Scope:** the install layout, the service identity, the runtime trust check and the threat model of the approval authority on Linux and macOS. No runtime code change is authorised by this document; each section names the PR in #4082 that implements it.
- **Numbering:** #4082 asked for `ADR-019-posix-authority-parity.md`. `ADR-019` was already taken by [ADR-019 control-room operator grant](ADR-019-control-room-operator-grant.md), so this record takes the next free number.

Evidence labels: GROUNDED (read in source at `origin/main`), DERIVED (follows from grounded facts), ASSUMED (a choice this ADR fixes).

## Context

ADR-016 put the approval authority behind a Windows service boundary. On every
other platform the boundary does not exist, and the runtime says so quietly:

- `resolveApprovalAuthorityMode` consults an installed pin only when
  `platform === 'win32'`; elsewhere it returns an env override or `legacy`
  (GROUNDED `lib/authority/authority-mode.js:57-93`; test
  `test/authority-pin-mode.test.js:62`).
- `applyStoreAcl` and `checkStoreAcl` answer `not_windows` off Windows
  (GROUNDED `lib/authority/store-acl.js:87,150`; tests
  `test/store-acl.test.js:71-74,102-104`).
- `agentBoundary` is `{ value: 'same-user', reason: 'not_windows' }` off
  Windows (GROUNDED `lib/authority/agent-user-boundary.js:97`; test
  `test/agent-user-boundary.test.js:131-140`).
- ADR-017 admits the gap: "Non-Windows parity ... is unaddressed here and
  tracked separately" (residual risk 2, `ADR-017-agent-user-boundary.md:166-169`).

Result: on Linux and macOS an agent runs as the operator and can approve its
own work. Two layers are handled separately:

- **Layer A, `boundary: os-service`.** The approval authority runs as a
  dedicated system user; the TOTP secret and signing keys live in a directory
  the agent cannot read. This closes the actual gap.
- **Layer B, `agentBoundary: os-user`.** The agent runs as a separate user and
  cannot reach the protected store at file level. It builds on Layer A.

### What Windows guarantees today (the property to reproduce)

| Guarantee | Mechanism | Evidence |
|---|---|---|
| Service runs under its own identity | `NT SERVICE\huqan-authority` via WinSW and `sc config obj=` | `scripts/authority/install-authority.ps1:35-36` |
| No user-writable code runs | closed `AUTHORITY_BUNDLE_FILES`, admin-only install dir | `lib/authority/bundle-manifest.js:12-33` |
| The bundle cannot load other code | `ALLOWED_BUILTINS` has no `child_process`, `vm`, `worker_threads`, `module` | `bundle-manifest.js:35-38`, `test/authority-bundle-closure.test.js` |
| Code outside the bundle refuses start | `loadedOutsideBundle(Object.keys(require.cache))` | `lib/authority/service-main.js:35-38,86-87` |
| `node.exe` is verified | Authenticode, minimum 22.13.0 | `install-authority.ps1` (`Install-Node`) |
| Package integrity | npm `dist.integrity` (sha512) | `install-authority.ps1` (`Get-VerifiedPackage`) |
| Secrets closed to the interactive user | inheritance removed; SYSTEM, Admins, service SID | `install-authority.ps1` (`New-ProtectedTree`) |
| Secrets are write-once | `writeOnce` (`flag: 'wx'`, `mode: 0o600`) | `lib/authority/state-store.js:28-49` |
| Runtime trusts only the pinned install | pin file, env cannot replace an installed pin, links give `install_path_linked` | `authority-mode.js:30-31,45-85` |
| A forged pin is rejected | live owner/DACL check, fail-closed | `lib/authority/install-trust.js` (`checkPathTrust`) |

POSIX-ready parts already in the tree: `protectedStateRoot` defaults to
`/var/lib/huqan/state` off Windows (`lib/protected-store-path.js:44-56`),
`isProcessElevated` is `euid === 0` (`lib/authority/store-migrate.js:150-153`),
and state files are written `0o600` (`state-store.js:29`, `ledger-store.js:46`).

## Decision

### 1. Identity and paths (approved by the owner on #4082, 2026-10-20)

Paths are constants in source, never derived from the environment.

| Role | Linux | macOS | Owner / mode |
|---|---|---|---|
| Service user | `huqan-authority` (`useradd --system --shell /usr/sbin/nologin`) | `_huqanauthority` (`dscl`, UID < 500, `IsHidden 1`, shell `/usr/bin/false`) | none |
| Code (bundle and node) | `/opt/huqan-authority/{node,app}` | `/Library/HUQAN/authority/{node,app}` | root; dirs 0755, files 0644, node 0755 |
| Data root | `/var/lib/huqan-authority` | `/Library/HUQAN/authority-data` | root, 0755 |
| Pin `public/authority.json` | `<data>/public/` | same | root; dir 0755, pin 0644 |
| `state/` | `<data>/state` | same | service user, **0700**, files 0600 |
| Log | journald | `/Library/Logs/HUQAN/authority.log` | service user, 0750 |
| Service definition | `/etc/systemd/system/huqan-authority.service` | `/Library/LaunchDaemons/com.huqan.authority.plist` | root, 0644 |

On macOS `/var` and `/etc` are symlinks into `/private`, which would break the
"no link on the path" rule; `/Library` avoids that (DERIVED). `/usr/local` is
not used because Homebrew can hand it to the user.

### 2. Node binary verification (approved on #4082)

On Linux the installer downloads the node tarball from nodejs.org and verifies
it against the GPG-signed `SHASUMS256.txt`. There is **no
`--allow-unverified-node` path** and no use of a system node. The minimum
version stays `>=22.13.0` (`package.json` `engines.node`).

The macOS installer (PR-5) answers open question 2b the same way: it downloads
the `darwin-<arch>` tarball from nodejs.org and verifies it against the same
GPG-signed `SHASUMS256.txt`. `codesign --verify` is **not** used: it proves an
Apple developer signature, not that this is the byte the release published, and
the GPG manifest already covers both platforms.

### 3. Service hardening

Linux unit (`User=huqan-authority`, `Group=huqan-authority`):

```ini
ExecStart=/opt/huqan-authority/node/bin/node /opt/huqan-authority/app/lib/authority/service-main.js serve --state-dir /var/lib/huqan-authority/state --port 47821
Environment=NODE_OPTIONS=
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/huqan-authority/state
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
SystemCallFilter=@system-service
Restart=on-failure
RestartSec=10
```

- `Environment=NODE_OPTIONS=` mirrors the empty `NODE_OPTIONS` of the WinSW
  definition (`install-authority.ps1:130`).
- The service makes no outbound connections (Rekor anchoring is run by the
  client, ADR-016 "Ledger anchors in Rekor"), so `IPAddressDeny=any` is safe.
- `MemoryDenyWriteExecute` is not used because V8 JIT needs writable-executable
  memory.

macOS launchd plist: `UserName=_huqanauthority`, the same `ProgramArguments`,
`RunAtLoad`, `KeepAlive`, `EnvironmentVariables` with `NODE_OPTIONS` empty,
`Umask=63` (0077), `StandardErrorPath` set to the log file; loaded with
`launchctl bootstrap system <plist>`.

### 4. Transport: keep the HTTP plus signature model

Decision safety does not depend on the caller's uid. It rests on (i) the
confidentiality of the TOTP secret, (ii) only the service being able to open a
sealed request, and (iii) the response being verified against the pinned key
(ADR-016 items 3-6). A process that squats the port can only deny service
(ADR-016 residual risk 5).

Rejected: peer-credential checks (`SO_PEERCRED`, `getpeereid`). Node's `net`
module does not expose them, and a native addon would break the closed bundle
(`bundle-manifest.js:38`). A Unix domain socket with a `0660` group is a
separate piece of work (open question 5).

### 5. Runtime path trust: `lib/authority/posix-path-trust.js` (new; runtime only, not in the bundle)

- For the pin, `public/`, the data root and **every ancestor up to `/`**:
  `lstat` is not a symlink, `uid === 0`, and `(mode & 0o022) === 0`. On Linux
  with POSIX ACLs the group bits show the mask, so the group-write check also
  catches a named-user write entry (DERIVED).
- macOS extended ACLs are invisible in mode bits. The check runs an injectable
  `spawnSync('/bin/ls', ['-lde', path])` probe; an ACL line, or a probe that
  cannot run, fails closed. The output format is pinned by a fixture.
- `state/`: owned by the service uid, `(mode & 0o077) === 0`; deviation gives
  `state_dir_exposed`.
- The reason vocabulary is the Windows one: `install_path_linked`,
  `install_path_untrusted`, `required_unavailable`.

### 6. `resolveApprovalAuthorityMode`

- The `win32` branch generalises to a per-platform layout
  `{ installDir, publicDir, pinPath, checkTrust }`; `linux` and `darwin` get the
  fixed paths of section 1. Unknown platforms behave as today.
- An installed, trusted pin gives `{ mode: 'service', boundary: 'os-service' }`.
  A pin that exists but is not trusted gives `required_unavailable` and **never
  falls back to legacy**.
- The env override applies only when no installed pin exists (current
  behaviour). `operator-cli.js:27` (`INSTALLED_PIN`) follows the platform.

### 7. Service self-checks (inside the bundle, `fs` and `process` only)

- `state-store.js:64` creates the state dir with `{ recursive: true, mode: 0o700 }`.
  Today it passes no mode, so a POSIX umask of 022 yields 0755 (DERIVED).
- Before listening on POSIX, `serveAuthority` refuses if `process.getuid() === 0`,
  if the state dir is not owned by `getuid()`, or if `mode & 0o077` is non-zero.

### 8. Layer B: `agentBoundary: os-user` on POSIX

- The vocabulary is unchanged (`os-user` / `same-user`); no new value.
- The marker is `/var/lib/huqan/state/agent-boundary.json` (macOS
  `/Library/HUQAN/state/...`), a fixed path. `HUQAN_PROTECTED_STATE_ROOT` is
  **ignored** by the boundary check because the agent controls its own
  environment (`protected-store-path.js:45-48`). The `v1` marker gains
  `agentUid` and `operatorUid` (from `SUDO_UID`).
- `os-user` requires all of: a trusted marker (section 5); `agentUid !== 0` and
  `agentUid !== operatorUid`; the uid from `getent passwd` / `dscl` matches the
  marker; the agent is not in `sudo` / `wheel` / `admin`; the store matches a
  POSIX spec (root-owned state root, a 0700 runtime-owned `workspaces/`, agent
  uid neither owner nor group, other bits 0); the migration marker verifies
  (`verifyMigrationMarker`).
- Reasons: `agent_uid_is_root`, `agent_is_operator`, `agent_uid_mismatch`,
  `agent_in_admin_group`, `store_mode_exposed`, and `unsupported_platform` for
  platforms still unsupported.
- `store-acl.js` gains a POSIX branch: `applyStoreAcl` uses `chownSync` /
  `chmodSync` (`huqan store migrate` already requires root,
  `store-migrate.js:150-169`); `checkStoreAcl` uses `lstat`. `STORE_ACL_SPEC`
  stays the single source for apply and check (`store-acl.js:13-16`).

### 9. Root and sudo edge cases (all fail closed)

| Situation | Behaviour |
|---|---|
| Install with `euid != 0` | the script refuses |
| Target dir already exists | refuses (counterpart of `install-authority.ps1:65-71`) |
| Service started as root | `serve` refuses |
| Runtime user has passwordless sudo | `os-service` is kept; `status` and `doctor` report `escalation: 'passwordless_sudo'` (open question 3) |
| Agent uid is 0 | `same-user`, `agent_uid_is_root` |
| Container (`/.dockerenv`, `/proc/1/cgroup`, `/run/.containerenv`) | `required_unavailable` / `container_unverified`; not supported in the MVP |

### 10. CI end-to-end (PR-6)

The installers cannot be exercised by the shards: they need root, a real
service manager and a real npm tarball, and once the authority is installed an
in-process approval is refused (ADR-016:150-153), so every later test in the
same process would see the installed pin. The e2e therefore lives in its own
workflow, `.github/workflows/authority-posix-e2e.yml`, on `ubuntu-latest` and
`macos-latest`, and its test file
(`test/authority-posix-install.e2e.test.js`) skips unless
`HUQAN_AUTHORITY_E2E=1`. That variable is the whole gate: the shards never set
it, and the workflow does.

To install without reaching the registry, both installers accept
`--tarball <path> --integrity <sha512-...>` (the answer to open question 4):
the file is the one `npm pack` just produced and the integrity is its sha512,
so the trust decision is the same check the registry path performs, only its
source changes. `--integrity` without `--tarball` is refused rather than
silently ignored, because an ignored flag reads as a verified install. A CI
runner also has no controlling terminal for `/dev/tty`, so
`--enroll-code-stdin` reads the code from stdin instead; the default path still
prompts on the terminal.

The job is **not** a required status check and does not run on a main push: it
mutates the runner and says nothing about the ordinary build. It is thrown
away, so no cleanup is promised beyond the uninstaller the last case runs.

### 11. Reporting the boundary (PR-7)

Section 9 says `os-service` is kept under passwordless sudo and the state is
reported. The report has two surfaces and one source:

- `lib/authority/authority-status.js` gains `escalation`, set on every mode
  (`legacy`, `required_unavailable`, `service`) because it is orthogonal to
  both the authority boundary and the agent-user boundary: a runtime can answer
  to a pinned service and still be able to `sudo`. The probe is
  `sudo -n true` -- non-interactive, read-only, argv fixed in source. It
  answers `passwordless_sudo`, `none`, `unknown` or `not_applicable`, and a
  probe that cannot run is `unknown`, never `none`: "could not tell" and "no
  sudo" are different claims and only one is safe to make. A probe that
  succeeds can do so through a cached credential as well as a `NOPASSWD` rule,
  and a probe that fails can hide a narrow `NOPASSWD` rule for one other
  command; the value is therefore named for what the probe observed, and the
  doctor detail never claims escalation is impossible from a failed probe.
- `huqan doctor` gains an `authority` check. It fails only where the boundary
  is claimed and does not hold: a required authority that is unavailable, a
  pinned service that does not answer under its own key, or an `os-service`
  boundary the runtime user can `sudo` past. `legacy` is the documented default
  and passes with a note, the same shape as the `egress` check. An
  `env-override` service answers under a pin the operator supplied and claims no
  OS boundary, so a passwordless sudo is reported there, not failed.

Answering open question 3: `boundary` stays `os-service` and the escalation is
reported alongside it. Dropping to a new boundary value would say the OS
boundary is absent, which it is not -- the service still holds the keys and
still answers; what is lost is the guarantee that only the operator can reach
it. That is a property of the deployment, so it is reported as one.

The new Core -> Adapters edge (`lib/cli-doctor.js` -> `lib/authority/authority-status.js`)
is recorded in `scripts/architecture-layer-exceptions.js` with a review date
rather than added to the baseline, because the baseline ratchet only shrinks;
the follow-up it names is to build the checker behind the `cli.js` entrypoint
and inject it, which the four existing `cli-doctor` Adapters edges wait on too.

## Threat model

| Scenario | Layer A | Layer B |
|---|---|---|
| Agent is the operator's user, no sudo | Cannot read the TOTP secret or forge a decision envelope; `decision-guard` refuses. Bypassing the runtime (editing code or `memory.db`) is possible but later detected by `huqan audit --authority` (ADR-016 risk 1) | out of scope |
| Agent is a separate user | all of A | store and runtime files are not writable by file permissions; risk 1 closes at file level |
| Agent has passwordless sudo or is root | **no guarantee** (counterpart of ADR-016 risk 3) | no guarantee |
| Same-uid keylogger or X11 capture of the sudo password | no guarantee; warned | narrowed by a separate session |
| Container | not supported in the MVP | not supported |
| macOS SIP / TCC | the design does not rely on them; extra layer only | same |
| Enrollment: TOTP seed read off the screen | enroll with agents stopped (ADR-016 risk 4) | closed by a separate session |
| Injection into the operator terminal (TIOCSTI, ptrace) | the decision window is `sudo .../huqan-authority-decide`; Linux >= 6.2 disables TIOCSTI by default and Yama `ptrace_scope` should be >= 1 (ASSUMED); ADR-016 risk 2 stays partly open | closed by a separate session |
| Local user reaches the loopback port | registration flood and global TOTP lockout DoS; cannot produce a decision | same |

### Non-claims (carried verbatim into the user-facing documentation)

- No guarantee against an agent that has root or passwordless sudo.
- No guarantee against a kernel exploit or against a shared kernel (ADR-017 risk 1).
- Containers, VMs and remote hosts are not supported in the MVP.
- SIP, TCC, AppArmor and SELinux are not relied upon.
- Layer A alone does not prevent a runtime bypass; it only makes it detectable.
- The caller's uid is not verified.
- TOTP proves the operator is present, not what the operator intended (ADR-016 risk 2).
- Sudoers rules added after install are visible only when `doctor` runs as root.

## Consequences

- ADR-017 residual risk 2 is answered: Linux and macOS get a service-user
  boundary (Layer A) first and the separate-agent-user boundary (Layer B)
  second. ADR-017 gains a one-line cross-reference to this ADR.
- Windows behaviour and tests do not change. The `not_windows` expectations in
  `test/store-acl.test.js:71-74,102-104` and `test/agent-user-boundary.test.js:131-140`
  are rewritten when the matching POSIX branches land (PR-9, PR-10).
- Side findings, each to be tracked outside this decision: ADR-017 section 3
  says the store is ACL'd "to the operator" while `STORE_ACL_SPEC` has no
  operator ACE (`ADR-017:101-103`, `store-acl.js:45-58`; open question 6);
  `canonicalWorkspaceRoot` lower-cases the path (`protected-store-path.js:71`),
  so `/x/Foo` and `/x/foo` collide on case-sensitive Linux (DERIVED);
  `THREAT_MODEL.md` and `SECURITY_INVARIANTS.md` do not mention the approval
  authority (**closed 2026-10-20, PR-8**: `THREAT_MODEL.md` gains an "Approval
  Authority Bypass" entry under Elevation of Privilege, and `SECURITY_INVARIANTS.md`
  SI-01 now names the authority and its POSIX path trust); `install-agent-user.ps1`
  is referenced but absent from the repo.
- Implementation plan (each PR single-purpose, test first, AGENTS.md section 8):
  Phase 1 (Layer A): PR-1 `posix-path-trust.js`; PR-2 POSIX pin in
  `authority-mode.js` and `operator-cli.js`; PR-3 service self-checks; PR-4
  Linux installer; PR-5 macOS installer; PR-6 `authority-posix-e2e` CI on
  `ubuntu-latest` and `macos-latest` (kept out of the shards: with the
  authority installed in-process approvals are refused, ADR-016:150-153) --
  `.github/workflows/authority-posix-e2e.yml` plus
  `test/authority-posix-install.e2e.test.js` and the installer flags in
  section 10;
  PR-7 `huqan doctor` and `status` `escalation`; PR-8 docs, `THREAT_MODEL.md`,
  `SECURITY_INVARIANTS.md`. Phase 2 (Layer B): PR-9 `store-acl.js` POSIX
  branch; PR-10 `agent-user-boundary.js` POSIX; PR-11 agent-user installers.

## Residual risks (kept honest)

1. **Distribution variance.** The MVP supports systemd on glibc only; other
   inits and libcs fail with an explicit error.
2. **macOS ACL probe output.** Pinned by fixtures; unparseable output fails closed.
3. **Real system changes in CI.** Confined to a separate job on an ephemeral
   runner with an uninstall step at the end.
4. **E2E leaking into shards.** Gated by `HUQAN_AUTHORITY_E2E` in a separate workflow.
5. **`os-service` mistaken for absolute protection.** The `escalation` field and
   the non-claims above exist to prevent that.

## Open questions (not decided here)

Questions 1 and 2 were decided by the owner on #4082 (sections 1 and 2). The
rest stay open and no default is assumed:

2b. macOS node verification: **answered by PR-5** (section 2): the GPG-signed
   `SHASUMS256.txt`, not `codesign --verify`.
3. With passwordless sudo, does `boundary` stay `os-service` and warn, or drop
   to a new value? **Answered by PR-7** (section 11): `boundary` stays
   `os-service`; `escalation: 'passwordless_sudo'` is reported beside it, and
   `doctor` fails on it.
4. Is `--tarball <path> --integrity <sha512>` on the install script acceptable for CI?
   **Answered by PR-6** (section 10): yes, with `--integrity` refused unless
   `--tarball` is given, and `--enroll-code-stdin` for the terminal-less runner.
5. Should a Unix domain socket with `0660` (flood-DoS mitigation) be its own work item?
6. ADR-017 section 3 ("ACL'd to the operator") versus `STORE_ACL_SPEC` (no
   operator ACE): which one is right?
7. When, and under which model, is container support added?
