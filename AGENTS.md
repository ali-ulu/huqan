# HUQAN Agent Rules — Mandatory

This file is mandatory for every coding agent working on HUQAN.

Before doing any task, the agent must read this file and obey it.

If any user/task instruction conflicts with this file, stop and ask for clarification.

## 0. Mandatory Context Bootstrap

Before every non-trivial task:

1. Read `docs/agent-canon.md`.
2. Read `docs/current-agent-checkpoint.json`.
3. Run `node scripts/agent-context.js`.
4. Let the script validate repository identity and canonical `origin/main`.
   On a feature branch, the current `origin/main` must be in the branch
   ancestry.
5. Stop on a source-reality conflict. Do not guess.

The generated capsule is task input, not repository authority. Live source,
tests, CI, and exact Git evidence remain authoritative.

## 1. Language

All user-facing reports, summaries, explanations, findings, and recommendations must be written in Turkish.

Allowed to remain English:
- code identifiers
- filenames
- branch names
- commit messages
- CLI commands
- test names
- API names
- literal error messages
- copied terminal output

## 2. Work Mode

Do not start coding immediately.

For every non-trivial task:
1. Inspect repo state.
2. Report current branch.
3. Report `git status --short`.
4. Report relevant recent commits.
5. Propose exact files to edit.
6. Wait for explicit approval unless the user already gave implementation approval.

## 3. Branch Discipline

Never work directly on `main` unless explicitly instructed.

Every PR/task must use a narrow feature branch.

Expected branch style:
- `v0.9.1/pr-mX-...`
- `productization/pr-cX-...`
- `docs/...`
- `chore/...`

Before committing, confirm:
- current branch is not `main`
- `git status --short` is understood
- only intended files changed

If you accidentally commit on `main`:
- stop immediately
- do not push
- do not repair automatically
- report the exact state and wait for instructions

## 4. Git Safety

Forbidden unless explicitly approved:

```bash
git add .
git add -A
git commit -am
git reset --hard
git clean -fd
git push --force
git push --force-with-lease
rm -rf
Remove-Item -Recurse
taskkill /F /IM node.exe
```

If cleanup seems necessary:

1. Run `git clean -nd` only.
2. Report the dry-run output.
3. Wait for approval.

Stage only explicitly intended files.

## 5. No Background Automation

Do not use:

* schedule
* manage_task
* reminder/task automation
* background task orchestration

For tests and long commands:

* run the command normally
* wait for terminal output
* report the result

Do not claim “no background automation” if schedule/manage_task was used.

## 6. Server Process Safety

Do not use broad process-kill commands such as:

```bash
taskkill /F /IM node.exe
```

To stop a server:

* use Ctrl+C in the terminal that started it, or
* stop only the specific process you started, by PID, after reporting it

Never kill all Node processes on the machine.

## 7. Test Discipline

No test bypass.

If tests fail:

* stop
* report exact failing files
* report exact failing test names
* report exact error messages
* do not claim success
* do not merge
* do not push

If dependencies are missing:

* run `npm ci`
* then rerun tests

Expected checks when relevant:

```bash
npm ci
npm test
```

For Memory Core work:

```bash
node --test test/memory-schema.test.js test/memory-store.test.js test/kernel-memory.test.js test/memory-store-sqlite.test.js
```

Clean clone verification is required before release/merge sealing when requested.

## 8. Scope Discipline

One PR = one purpose.

Do not mix:

* runtime changes
* docs changes
* UI changes
* tests
* release metadata
* cleanup
* experiments

unless explicitly approved.

Negative scope must be preserved.

If the task says not to touch a file, do not touch it.

If a file is accidentally touched:

* stop
* report
* do not silently restore unless instructed

## 9. Final Report Format

After every task, report in Turkish:

1. Branch
2. Commit, if any
3. Files changed
4. Tests run
5. Test result
6. What was intentionally not touched
7. Any blocker
8. Recommended next step

Never say “done” unless:

* `git status --short` was checked
* changed files were listed
* tests/smoke were reported
* unrelated drift was reported

