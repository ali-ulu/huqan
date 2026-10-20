# 30-Minute Install: Gate, Approval Authority, Trust Receipt

Goal: on a clean server, stand up the **gate -> approval -> receipt** chain and
prove it works end to end, in under 30 minutes. Every command below was run on a
fresh `ubuntu:24.04` container and a fresh clone; the measured times are in
[Timing](#timing).

If you only want the knowledge base and CLI, read [Local Install
Guide](./local-install.md) instead. This page is the operator path: the gate
that blocks an agent's action, the approval that authorizes a mutation, and the
receipt that records the decision.

## What you get

| Layer | What it does | Installed by |
|-------|--------------|--------------|
| Gate | Blocks a client action before it runs, per the external-action policy | `huqan-gate install --profile <client>` |
| Approval Authority | Moves the approval decision behind an OS boundary (Windows service; systemd on Linux) | `scripts/authority/install-authority.ps1`, `scripts/authority/install-authority.sh` |
| Trust Receipt | Records each admission/rejection in an append-only chain you can verify | written automatically |

## Requirements

- **Node.js >= 22.13.0** (verify with `node --version`)
- **Build tools** for the native `better-sqlite3` module: `make`, a C++
  compiler (`g++`), and `python3`. The one-line install below includes them; a
  minimal image without them fails at `npm run setup:sqlite` (see
  [Troubleshooting](#troubleshooting)).
- **OS**: Linux (Ubuntu LTS), macOS, or Windows 11 (PowerShell)
- **Disk**: ~250 MB with `node_modules`
- **RAM**: ~150 MB at runtime

---

## Part 1 - Install (Ubuntu LTS)

Measured: **43 s** from a bare container.

```bash
# 1. Prerequisites (includes the build tools better-sqlite3 needs)
sudo apt-get update
sudo apt-get install -y curl git ca-certificates gnupg make g++ python3

# 2. Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version            # expect v22.x

# 3. Clone and install
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm run setup:sqlite      # installs deps and builds better-sqlite3
```

Expected: `npm run setup:sqlite` exits `0`. If it prints `gyp ERR! not ok`, the
build tools are missing - install `make g++ python3` and rerun.

## Part 2 - Install (Windows 11)

```powershell
# 1. Node.js 22.x (LTS) from https://nodejs.org, or:
winget install OpenJS.NodeJS.LTS
node --version            # expect v22.x

# 2. Clone and install (no extra build tools needed: better-sqlite3 ships a
#    prebuilt binary for Windows on supported Node versions)
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm run setup:sqlite
```

If `npm run setup:sqlite` tries to compile from source, install the "Desktop
development with C++" workload from Visual Studio Build Tools and rerun.

---

## Part 3 - Verify the install

```bash
node cli.js doctor
```

Expected: most lines `OK`. Two `FAIL` lines are normal on a plain install:

- `Rust accelerator FAIL` - the optional native accelerator is not built.
- `Server bind FAIL` - only appears inside a container with the default
  loopback bind; set `HUQAN_HOST=0.0.0.0` to serve the UI/API from outside.

`doctor` exits `0` even with those `FAIL` lines, because both are optional.

---

## Part 4 - Install the gate

The gate is a pre-execution guard: the client calls it before running a tool,
and the gate returns `allow` or `deny` with a receipt id.

```bash
# From your project directory (not the huqan repo):
node /path/to/huqan/bin/huqan-gate-hook.js install --profile openhands
```

Expected (JSON): `"installed": true`, a `"target"` path such as
`./.openhands/hooks.json`, and `"sentinel": { "live": true, ... }`. The sentinel
is the gate exercising itself once to prove it blocks a denylisted command.

Profiles: `claude-code`, `codex`, `openhands`, `opencode`, `pi`, `hermes`. Use
the one matching your client. The gate enforces only when the client calls it
before executing - see [External Action Guard](./external-action-guard.md).

## Part 5 - Issue an agent identity card

By default the gate **blocks an action with no capability card**. Mint one:

```bash
node /path/to/huqan/bin/huqan-gate-hook.js identity issue \
  --agent-id agent:default:operator \
  --owner actor:operator \
  --capabilities shell,file_write \
  --out card.json
```

Expected: `"ok": true` and a `card.json` written. Capabilities come from the
external-action vocabulary: `shell`, `file_read`, `file_write`, `network`,
`memory`, `deployment`, `permission`, `automation`, `tool`, or `*`.

For a signed card (so a verifier can attest it), generate a key pair and sign in
the same call:

```bash
node /path/to/huqan/bin/huqan-gate-hook.js identity issue \
  --generate-keypair ./keys \
  --agent-id agent:default:operator \
  --owner actor:operator \
  --capabilities shell \
  --out opcard.json \
  --sign-key ./keys/identity-card-private.pem \
  --out-signature opcard.sig.json
```

To opt out of the identity requirement instead (weaker - any caller is admitted):

```bash
export HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY=allow
```

## Part 6 - Install the Approval Authority (Windows)

The authority moves the approval decision behind an OS boundary: a Windows
service holds the signing key and TOTP, so code running as your user cannot
approve its own proposal. See [ADR-016](./adr/ADR-016-approval-authority-os-boundary.md).

```powershell
# Elevated PowerShell
powershell -ExecutionPolicy Bypass -File scripts\authority\install-authority.ps1
node bin\huqan-authority.js status
```

Expected: `"mode"` is no longer `"legacy"` and `"boundary"` reports the service
boundary rather than `"same-user"`.

On Linux the same boundary is installed by
`scripts/authority/install-authority.sh` (systemd, root), and on macOS by
`scripts/authority/install-authority-darwin.sh` (launchd, root). Both verify the
node tarball against the GPG-signed `SHASUMS256.txt` and install only the
bundle. The remaining parity work is tracked in
[ADR-020](./adr/ADR-020-posix-authority-parity.md) and issue #4082.

---

## Part 7 - Prove it: gate -> receipt -> verify

This is the acceptance step. Run all three and check the outputs.

**Step 1 - the gate blocks an action and writes a receipt.**

```bash
export HUQAN_DB_PATH="$PWD/memory.db"     # pin the store (see Troubleshooting)
echo '{"event_type":"PreToolUse","tool_name":"terminal","tool_input":{"command":"rm -rf /"},"session_id":"s1"}' \
  | node /path/to/huqan/bin/huqan-gate-hook.js --profile openhands
```

Expected:

```json
{"decision":"deny","reason":"HUQAN blocked action: DENYLISTED_COMMAND_BLOCKED. Receipt xact_adm_..."}
```

**Step 2 - the receipt is on the trail and counted.**

```bash
node /path/to/huqan/bin/huqan-gate-hook.js overview
```

Expected: `"connected": 1`, `"acting": 1`, and the profile shows
`"byDecision": { "block": 1 }`. The trail is
`~/.local/state/huqan/external-action-receipts.jsonl`.

**Step 3 - the approval chain and its receipt verify.**

The admission receipt (a mutation the operator approved) verifies against its
hash chain:

```bash
node cli.js quickstart          # one command: propose -> approve -> verify -> receipt
```

Then, to verify a receipt in your own graph:

```bash
# Learn a fact (it is queued for review), approve it, then verify its receipt.
node cli.js                    # then, in the shell:
#   learn: smoking causes cancer
#   onaylar                     # list pending approvals, copy the id
#   onayla <approval-id>        # confirm by typing the id again
#   exit
node cli.js receipt verify <madm_receipt_...> --workspace default
```

Expected: `Trust Receipt <id> verifies: its chain in workspace default is intact
from genesis to the recorded tip (receiptHash ...)`.

> Note: `onayla` needs an interactive terminal (it asks you to retype the
> approval id). Piping it through `echo` fails with
> `operator_terminal_required`.

> Note: a **gate** receipt (`xact_adm_...`) is written to the trail and the
> audit log, but `huqan receipt <xact_adm_...>` currently answers `NOT_FOUND:
> receipt was not found in the materialized read index`. The read index expects
> the audit event's `details.receipt` nested object; the gate writes the receipt
> flat. Use `overview` / `--identity-log` to read gate receipts today. This is
> item 3 in the installation-gaps list on issue #4103.

---

## Timing

Measured on a fresh `ubuntu:24.04` container and a fresh clone:

| Step | Time |
|------|------|
| `apt` prerequisites + Node.js 22.x | ~34 s |
| `git clone` | ~3 s |
| `npm run setup:sqlite` | ~6 s |
| **Install subtotal** | **~43 s** |
| Gate install | <1 s |
| Identity card issue | <1 s |
| Prove-it chain | ~3 s |
| **Total** | **~50 s** |

Well under the 30-minute budget. The dominant cost on a real server is the
`apt`/Node download, which depends on your mirror.

---

## Troubleshooting

**`npm run setup:sqlite` fails with `gyp ERR! not ok`:**
- Install the build tools: `sudo apt-get install -y make g++ python3`, then
  rerun. A bare `ubuntu` image lacks `make` and `g++`.

**The gate fails closed with `refusing to create a new store at an unnamed path`:**
- The gate derives `memory.db` from the working directory. If a store already
  exists elsewhere, it refuses rather than fork state. Point it explicitly:
  `export HUQAN_DB_PATH=/path/to/memory.db`, or set `HUQAN_ALLOW_NEW_STORE=1`
  to create a new store on purpose.

**The gate fails with `Cannot find module 'proper-lockfile'`:**
- You are running the gate without a full `npm ci`/`npm run setup:sqlite`.
  Install dependencies first.

**`onayla` says `this decision needs the operator at an interactive terminal`:**
- Approval requires a TTY and a typed confirmation. Run `node cli.js` in a real
  terminal, not through a pipe.

**Port 3000 already in use:**
```bash
lsof -i :3000                 # macOS/Linux
netstat -ano | findstr :3000  # Windows
```

---

## Where to go next

- [External Action Guard](./external-action-guard.md) - gate profiles and policy
- [Portable Trust Receipt](./portable-receipt.md) - verify a receipt without HUQAN
- [ADR-016](./adr/ADR-016-approval-authority-os-boundary.md) - the OS boundary
- [ADR-020](./adr/ADR-020-posix-authority-parity.md) - Linux/macOS parity (open)
- [Local Install Guide](./local-install.md) - the CLI/knowledge-base path
