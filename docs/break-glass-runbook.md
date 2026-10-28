# Break-glass runbook

> Audience: an operator (SRE, release engineer, on-call) who needs to get a
> change through an incident without turning the guard off. This is the short
> version; the reasoning lives in `lib/break-glass.js` and
> `lib/break-glass-gate.js`.

## What a break-glass window is

A window is a **time-boxed, narrowly-scoped, reason-carrying override**. It
turns one kind of decision -- a call the guard would hold for a human review --
into a call that runs. Nothing else.

A window **cannot** make a blocked action run. A deploy, a force-push, a
destructive delete, a secret write and a branch-protection change are blocks;
they stay blocked while a window is open. If you need one of those, that is the
approval authority's decision (ADR-016), not a window's.

## The four bounds

| Bound | Enforced where | Limit |
|---|---|---|
| time | `issue` refuses a TTL outside the range | at most 60 minutes (`MAX_WINDOW_MS`) |
| scope | `check` refuses a workspace/agent/category mismatch | one workspace, optionally one agent, optionally a category set |
| reason | `issue` refuses an empty reason | required, stored, shown in every receipt |
| uses | `consume` refuses past `maxUses` | at most 50 (`MAX_USES`) |

A window is not a policy file and it is not a global switch. It is one row in a
hash-chained ledger, read on each call.

## Opening a window

Issuing a window is an operator decision, so the command needs the operator at
an interactive terminal -- the same credential `huqan terfi` and
`huqan onayla` already require. A pipe, a heredoc or a spawned shell has no
terminal, so it is refused with exit 4 (`OPERATOR_AUTH_REQUIRED`) before the
ledger is touched. That is the point: an agent's own shell is exactly such a
process, so an agent cannot open the window that would lift the gate holding it.

```bash
huqan-gate break-glass issue \
  --reason "18:40 CI is red; unblock the hotfix path for 30 minutes" \
  --actor operator:cli \
  --ttl-ms 1800000 \
  --max-uses 20 \
  --workspace-id default
```

The command prints the window, including its `windowId` and `expiresAt`. Point
the hook at that id:

```bash
huqan-gate evaluate --break-glass <windowId> ...
```

Only the `windowId` is passed to the hook. The window itself lives in HUQAN's
own state directory (`HUQAN_BREAK_GLASS_DIR`, or
`<state root>/break-glass`), and the directory is deployment configuration,
never a command argument: there is no `--dir`, because an agent that could name
the path could point the guard at a ledger it wrote itself. An agent can set
the flag, but a flag only names an id -- an id no operator issued does not
resolve, and an agent cannot write the ledger the id is read from.

Two halves guard this, and they are separate on purpose:

- The **hook** refuses the verb from an agent's shell outright. `break-glass` is
  an operator decision in `lib/control-plane-paths.js`
  (`OPERATOR_DECISION_COMMANDS`), so `huqan-gate break-glass issue ...` meets a
  *block*, not a review. This is what the agent actually encounters.
- The **CLI** refuses without an operator terminal (above), so even reached
  directly the verb needs the operator present. This is the backstop.

Neither half is the OS boundary. Code running as the same OS user can drive a
pty; where an approval authority is installed (ADR-016), that is the boundary
for anything a window would otherwise carry, and a window does not stand in for
a decision there.

## Seeing what is open

```bash
huqan-gate break-glass status
```

Lists every window with its reason, actor, expiry, use count and whether it is
currently active. A window that is expired, exhausted, lifted or out of scope
reads `"active": false` with the reason.

## Closing a window early

```bash
huqan-gate break-glass lift --window <windowId> --actor operator:cli
```

Lifting records one entry and is idempotent. Do this as soon as the incident
closes; do not rely on the TTL alone.

## What happens when HUQAN itself is down

This is the question the runbook exists to answer plainly.

- A window is **data inside HUQAN**. If no HUQAN process is running, nothing
  reads the window, so it grants nothing.
- The hook fails closed on any error: `bin/huqan-gate-hook.js` exits `2`, and
  every adapter projection enforces a non-zero exit as a deny.
- Therefore a crashed HUQAN **cuts operations off**; it does not allow them. An
  open window does **not** survive as blanket permission.

So "HUQAN is down" is a full stop, not a bypass. That is the safe direction: the
failure mode of a broken guard is "nothing runs", which an operator notices
immediately, rather than "everything runs", which nobody notices until later.

## If the ledger is tampered with

The ledger is a hash chain. If it does not verify:

- every window reads as **inactive** (`break_glass_integrity_violation`);
- `issue` **refuses** to append to a chain it cannot trust.

This is the opposite of the emergency stop, on purpose. A brake must always be
available, so the stop proceeds on an integrity violation. An override must
never be available when its record cannot be trusted, so a window fails closed.

## What a window is not

- It is not a way to approve a blocked action. Blocks stay blocked.
- It is not an approval-authority decision. Where an authority is installed,
  lifting an emergency stop and the other operator actions still require its
  consumed decision; a window does not stand in for that.
- It is not unbounded. Every window has an expiry, a use cap and a reason, and
  every use is a ledger entry.
