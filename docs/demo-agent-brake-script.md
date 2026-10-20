# The 15-minute agent brake demo

One command shows a mutating action held for a person's approval, and the receipt
that proves what happened. This document is the presenter's script for a
fifteen-minute session: three minutes of problem, seven of demo, three of
questions, two of closing.

Everything below runs from a clean clone, offline, on Windows, macOS or Linux.

## Before anyone joins (5 minutes, not on the clock)

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
npm ci
npm run demo:agent-brake        # the whole run takes well under two seconds
npm run demo:agent-brake -- --reject   # the same run, operator says no
```

The first run must end with `demo OK: blocked, decided, executed once, receipt
verified`; the second with `demo OK: blocked, rejected, nothing executed,
receipt verified`. A `demo FAILED:` line names the check that failed and is the
only reason to cancel the session.

Keep a terminal open at 18pt, no other windows, and a second terminal with
`npm run demo:agent-brake -- --reject` ready to paste.

## Minutes 0-3: the problem

Say this in your own words; the numbers are the point, not the wording.

1. An agent with a shell is an agent that can delete your working tree, rewrite
   `.env`, or open a pull request you did not read. The agent is not malicious;
   it is confident, and confidence is the failure mode.
2. The usual answer is a policy prompt in the system message, or a "yes to all"
   toggle a tired person turns on by Wednesday. Neither leaves a record, and
   neither is checked after the fact.
3. What is missing is not another prompt. It is a gate that sits *between* the
   agent and the effect, decides `allow` / `review` / `block` in code, and writes a
   receipt for the decision it made.

Do not spend these minutes on architecture. The audience should leave this
section believing one thing: the agent never decides for itself whether it may
act.

## Minutes 3-10: the demo

### Step 1 (90 s): the delete that does not happen

```bash
npm run demo:agent-brake
```

Stop at the first block. Point at three lines:

- `gate review external_action_review_required` — not a block. The action is
  held, not refused, because a delete inside the agent's own workspace is a
  legitimate thing a person may approve.
- `hook answer ask` — what Claude Code receives. The agent is stopped by the
  host it is running in, not by a promise in its prompt.
- `executed no notes.txt is still there: yes` — the file on disk, read after the
  fact. This is the line to read out loud.

Then the admission receipt id. It was written when the gate decided, before
anyone was asked, so the trail has an entry even for the request that went
nowhere.

### Step 2 (90 s): the operator decides

Point at the wrong code first: it is refused (`TOTP_INVALID`), and the demo does
not retry it a hundred times. Then the printed code — the demo's phone screen —
and the `otpauth://` URI, which any authenticator app accepts. Say plainly what
the code buys: presence, in a way code running as the same OS user cannot fake.
The code is accepted once; a replay is refused.

### Step 3 (90 s): only an authorized decision executes

The gate answers `review` again — a delete never becomes an automatic allow —
and the delete runs only because the decision above authorizes that approval,
that workspace, that tool and that action hash. The effect happens inside the
same mutation that records it: the delete and the receipt that claims it are one
unit.

### Step 4 (60 s): the receipt

Read the four lines: the receipt id, its hash, `chain intact from genesis to the
tip`, and `seal signed, signature valid (key …)`. Then point out that the
verification is not a demo helper: it is `readReceiptById`, the same code path
`huqan receipt verify <id> --workspace <id>` runs.

### Step 5 (60 s): the part that makes it honest

The demo has no approval authority installed, so it stands one in. Step 5 is
that stand-in being refused by the runtime's own decision guard
(`DEMO_AUTHORITY_REFUSED`), in both service mode and same-user mode. Say it
without hedging: a demo must never be able to authorize production, and this is
the line of code where that is decided.

If an approval authority *is* installed on the presenting machine, the demo still
runs its own simulation and still shows the refusal; the real decision is taken
with `huqan-authority decide <approvalId>` against the service, which holds the
only signing key and the TOTP secret. Show that command in the slide, do not
improvise it live.

### Optional (60 s): the rejection

```bash
npm run demo:agent-brake -- --reject
```

The operator says no, the file is still there, and the receipt says
`not_executed`. This is the run to show when someone asks "what if the human
disagrees?"

## Minutes 10-13: the three questions

1. **"Why `review` and not `block`?"** Because a brake is not a wall. A block is
   for the cases nobody should approve — control-plane paths, operator-decision
   commands, an unattested identity. Everything else is held for a person, which
   is the difference between a product people keep installed and one they turn
   off.
2. **"Can the agent approve its own action?"** Not with a signature it can
   produce. The decision has to come from the authority service, outside the
   agent's OS user, and the runtime refuses everything else. The demo's own
   stand-in is refused exactly as an agent-minted envelope would be.
3. **"What does the receipt prove?"** Origin and integrity: this gate decided
   this, about this action, at this time, and the chain has not been edited
   since. It does not prove the operator was honest — whoever holds the issuing
   key can rewrite and re-sign the trail. Independence needs a collector
   counter-seal held by a party the operator does not administer. Say this before
   someone else asks it for you.

## Minutes 13-15: the closing

Two sentences, then stop:

- Models generate, agents act, memory stores. HUQAN judges — at the seam where a
  judgement still changes the outcome, and it writes the receipt before the effect.
- `npm run demo:agent-brake` is the whole claim on your machine, in under two
  seconds, with nothing of yours touched.

Then the call to action you prepared. Commercial terms are out of scope for this slot.

## What this demo does not prove

Say these if asked, and volunteer the first one:

- The approval authority is stood in for. The demo shows the *shape* of the
  decision and the refusal of the stand-in, not an installed OS boundary.
- The issuer seal proves a receipt's origin and integrity, not the operator's
  honesty.
- The demo drives the gate's own adapter, the one the installed hook calls, so
  the decision and the receipt are the production ones — but it does not install
  the hook into a host agent, and it does not run a real agent process. Real
  protection depends on `huqan-gate install --profile claude-code` in the host
  the agent runs in, which this demo does not do to your machine.
- The workspace is a temporary directory under the system temp root, left for
  the OS to remove. Nothing outside it is read or written.

## Regenerating the recording

The recording in the README is produced by the command it documents:

```bash
npm run demo:agent-brake -- --record=docs/agent-brake-demo.cast
asciinema play docs/agent-brake-demo.cast
```

Re-record it whenever the printed output changes, so the README never shows a
run nobody can reproduce.
