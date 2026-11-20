# Coder quick start

`coder` runs one bounded, deterministic code transform through the ordinary
code-change gate. It is not general autonomous coding: it does exactly what the
task file declares, inside the paths the task declares, and nothing else. The
full claim boundary is in [`coder-bounded-contract.md`](./coder-bounded-contract.md).

## Prerequisites

- A clean Git repository on a **feature branch** (a non-main branch). Runs on
  main are denied; a dirty working tree is held at
  `DIRTY_REPO_REVIEW_REQUIRED`.
- Every file the task touches must be listed in `allowedPaths`.
- The task file and any output the task produces must stay untracked, or the
  run is blocked at the same dirty-tree review gate.

## The task file, in full

A `task.json` looks like this (the fields that matter, exactly as validated in
`lib/coder/`):

```json
{
  "level": "l0",
  "intent": "bump docs/version.md from v1.0.0 to v1.1.0",
  "operation": {
    "type": "replace_text",
    "path": "docs/version.md",
    "find": "v1.0.0",
    "replace": "v1.1.0"
  },
  "allowedPaths": ["docs/version.md"],
  "test": { "command": "node acceptance.test.js" }
}
```

- `operation` — the deterministic transform. Supported `type` values:
  `replace_text`, `insert_after`, `rename_identifier`, `create_file`,
  `sequence` (catalog notes: [`coder-catalog-notes.md`](./coder-catalog-notes.md)).
- `allowedPaths` — required. The transform refuses any path outside this list.
- `test.command` — the operator-supplied independent acceptance test. Coder
  never invents its own oracle.
- `level` / `intent` — provenance metadata carried into the journal.

You rarely hand-write this file: `coder propose <failure.json>` derives it from
a verified failure record. The failure record itself is `{ kind: "failure_record",
failureId, verificationStatus, operation, observed, expected, ... }` —
`kind: "failure_record"` is validated on the record, not the task
(`lib/task-producer.js`).

## `coder propose --source`: the trusted acceptance oracle

A bare `coder propose` prints a task with no `test` and no learning
eligibility. Nothing learns from it. Attaching an oracle is opt-in through
`--source <source.json>`, and the whole point of that flag is the question
"who supplied this oracle?". The answer decides whether a verified failure may
become learning-eligible at all (`lib/experience/learning-source.js`).

The source file declares the evidence:

```json
{
  "hash": "<sealedFailureHash of the failure record>",
  "outcomeStatus": "verified",
  "allowedPaths": ["docs/version.md"],
  "oracle": { "command": "node --test test/version.test.js", "timeoutMs": 120000 }
}
```

`hash` must equal the failure record's own sealed hash, so one failure's id
cannot be paired with another failure's evidence. `allowedPaths` must contain
every path the failure touched.

### Independence comes from a signature, not from the file or the environment

The source file is written by whoever proposes the task, so a `suppliedBy`
field inside it proves nothing. An environment variable is no better: the
proposing agent starts its own process and writes its own environment, so
`HUQAN_ACCEPTANCE_CHANNEL=ci` would be self-certification (this is #4624).

Independence is therefore a property of *who signed the oracle*. The operator
registers the acceptance oracle with the approval authority, decides it there,
and `huqan-authority apply` produces a signed decision envelope — the same
Ed25519 envelope, pinned key and verifier that every other operator decision
uses (`lib/authority/decision-envelope.js`). That envelope is the attestation:

```json
{ "channel": "ci", "envelope": { "alg": "Ed25519", "keyId": "...", "sig": "...", "payload": { ... } } }
```

### Registering the oracle

`huqan.acceptance_oracle` is an operational approval, like `terfi` and
`huqan.agent_resume`: it is registered with the authority rather than stored as
a runtime approval row. The `--args` object is exactly the evidence the
decision will bind, so registration and verification hash the same bytes.

```bash
huqan-authority request huqan.acceptance_oracle --workspace default --args '{
  "sourceHash":     "<sealedFailureHash of the failure record>",
  "commandHash":    "<sha256 of the acceptance command>",
  "allowedPathsHash": "<allowedPathsHash of the declared path set>",
  "channel":        "ci"
}'
```

Then decide it in the HUQAN Authority window and apply it:

```bash
huqan-authority apply ops-<id> | jq .attestation > attestation.json
HUQAN_ACCEPTANCE_ATTESTATION=attestation.json huqan coder propose failure.json --source source.json
```

`apply` prints the attestation under the `attestation` key because this
approval has no side effect to perform — the signed envelope is the whole
result. The `jq` pipe matters: the verifier reads `channel` and `envelope` at
the top level, so the saved file must be that nested object and not the whole
report. Saving the raw output points the variable at a file that cannot verify.

The signed payload binds the exact evidence it authorizes, so one attestation
authorizes one failure, one command and one path set
(`lib/experience/acceptance-attestation.js`):

| Bound value | What it pins |
|---|---|
| `sourceHash` | the sealed failure record the candidate derives from |
| `commandHash` | the acceptance command itself |
| `allowedPathsHash` | the exact path set the candidate may touch |
| `channel` | `operator` or `ci` |
| `approvalId` | this one approval, not a sibling's |
| `workspaceId` | the workspace the failure record came from |

Replaying the attestation against a different record, a swapped command or a
wider path set fails the binding check. A file the agent writes itself fails
the signature check, because the agent does not hold the authority's key.

### How the attestation reaches the process

`HUQAN_ACCEPTANCE_ATTESTATION` names the file to read. That variable is not
evidence — a proposer can set it — it only says where the signed envelope is.
The proof is the envelope's signature against the installed pin.

The earlier draft read the channel from `HUQAN_ACCEPTANCE_CHANNEL` and the
command from `HUQAN_ACCEPTANCE_COMMAND`. Both are **not** trusted inputs and are
no longer read at all: setting `HUQAN_ACCEPTANCE_CHANNEL=ci` grants nothing
(#4624). A launcher still exporting them just gets the same refusal as no
attestation, which is the correct answer for a self-declared channel.

### What refuses, and why that is correct

| Situation | Result |
|---|---|
| No `--source` | Task printed with no test, `learningEligibility: null`. |
| `--source` with no attestation | `oracle_supply_unverified`. |
| Attestation signed by a key other than the pin | `oracle_supply_unverified` (`key_mismatch` in `detail`). |
| Attestation for different evidence | `oracle_supply_unverified` (`binding_mismatch`). |
| Attestation past `validUntil` | `oracle_supply_unverified` (`expired`). |
| `suppliedBy: "source-file"` | `oracle_not_independent`. |
| No `os-service` authority installed | `oracle_supply_unverified`. |

That last row is the one worth reading twice. Only an `os-service` authority
counts as a trust anchor. An `env-override` pin (`HUQAN_AUTHORITY_PIN_PATH`) is
refused for the same reason a channel variable is: the proposing agent chooses
its own launcher, so it could point at a pin and keypair it minted itself.
Legacy mode has no pin at all. In both cases independence is *unavailable*, and
the command says so rather than assuming it. Install the approval authority
([`authority-install-posix.md`](./authority-install-posix.md)) to make the
accepting path reachable.

A conflicting outcome (`verificationConflicting: true`) is escalated as
`outcome_conflicting` for a human decision; it never prints a task. An
unattested record is refused at the oracle check before it can reach that
branch, so nothing is escalated as if it had been verified.

## The acceptance test is `node <file>` only

The acceptance test is executed as `node <file>` and nothing else. The allowed
executable list is exactly `['node']` (`lib/coder/test-execution.js`). `node -e`,
`node -r`, `node --import`, `npm test`, `grep`, shell pipelines and any other
executable are rejected before any test process runs. Write the acceptance
check as a Node script that exits non-zero on failure.

## Subcommands

| Command | What it does |
|---|---|
| `coder <task.json> [--dry-run] [--root <dir>] [--verify ocr] [--authorize] [--json]` | Run one task through the gate; apply, test, record. |
| `coder create --initialize-project --journal <journal>` | Initialize a coder project in the current repository. |
| `coder revise --requirements-text <text> --previous-requirements <file>` | Revise project requirements from text; requires the previous requirements file. |
| `coder propose <failure.json> [--source <source.json>] [--root <dir>] [--json]` | Turn a verified failure record into a candidate task; prints the task, changes nothing. `--source` attaches an authority-attested acceptance oracle. |
| `coder verify <record.json> [--base <git-ref>] [--base-dir <dir>] [--root <dir>]` | Re-derive a recorded transform on the base and report whether the tree contains its output. Intended for the reviewer, not the author. |
| `coder remember ...` | Record candidate/experience memory for a non-project task. |

Dispatch lives in `lib/cli-coder.js`; each subcommand's own module documents
its flags at the top of the file.
