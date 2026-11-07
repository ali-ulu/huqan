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
| `coder propose <failure.json> [--root <dir>] [--json]` | Turn a verified failure record into a candidate task; prints the task, changes nothing. |
| `coder verify <record.json> [--base <git-ref>] [--base-dir <dir>] [--root <dir>]` | Re-derive a recorded transform on the base and report whether the tree contains its output. Intended for the reviewer, not the author. |
| `coder remember ...` | Record candidate/experience memory for a non-project task. |

Dispatch lives in `lib/cli-coder.js`; each subcommand's own module documents
its flags at the top of the file.
