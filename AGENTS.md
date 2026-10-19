# HUQAN Agent Rules — Mandatory

This file is mandatory for every coding agent working on HUQAN.

Before doing any task, the agent must read this file and obey it.

If any user/task instruction conflicts with this file, stop and ask for clarification.

## 00. Read First — Active Program, Graph, Smallest Change

Agents kept missing these three. Do them before section 0.

1. **Active program.** Open the GitHub Project
   https://github.com/users/ali-ulu/projects/7 (Cognitive Architecture
   Program, COG; epic #4060). Work in the COG scope (section 11) starts from
   its `[COG-Mx]` issue and moves the card's `Durum` field.
2. **Graphify.** Your worktree has no graph: `graphify-out/` is gitignored.
   Build it before the first code question: `graphify update .` (AST only,
   no API cost, about 5 minutes on this repo). Then `graphify query "<q>"`
   before the first grep or source read. An absent graph is a reason to
   build it, not to skip it (`GRAPHIFY-001`).
3. **Smallest complete change.** Follow section 12 before writing code.

*Not enforced by CI yet.*

## 0a. PR Ownership (agency rule)

The agent that opens a PR owns that PR. "İşi bitene kadar" içinde:

- PR'ı yeşile döndürmekle yükümlüdür (CI dahil).
- Merge edilebilir hale getirmekle ve merge etmekle yükümlüdür.
- PR kapanana/merge edilene kadar takip eder; başka ajan/insan devralmadıkça bırakmaz.

## 0b. Multi-agent coordination

Several agents (Claude Code, Codex, Codebuff, others) work on this repository
at once. Every rule below exists because breaking it cost the operator hours
on 2026-10-14. Each rule names what enforces it, or says that nothing does.

1. **Look before you start.** Before working on an issue, run
   `gh pr list --state open --search "<issue number>"` and check the open PRs
   that touch the files you will change. If another agent already has a PR,
   continue that PR or comment on it. Do not open a parallel one.
   Two PRs for the same phase (#3881, #3882) conflicted and one had to be
   closed. *Not enforced by CI.*
2. **Claim the work early.** Push a draft PR with your first commit, so the
   next agent's search finds it. *Not enforced by CI.*
3. **Use your own worktree.** Never work in a clone another agent may be
   using: `git worktree add <scratch>/wt-<task> -b <branch> origin/main`.
4. **Sign every commit.** `main` requires signatures (`required_signatures`).
   An unsigned commit can only be fixed by rewriting the branch, which needs
   the operator. Check with `git log --format='%h %G?' origin/main..` before
   pushing. *Enforced by the ruleset at merge time, so too late to be cheap.*
5. **Contract documents are code.** `README.md` and the other root `*.md`
   files are pinned by tests that read them. CI now runs those tests on a
   documentation-only PR (`IMPACT_ONLY_PATTERNS`, #3895). Still run them
   locally first: `node --test $(grep -l "README.md" test/*.test.js)`.
6. **Do not merge into a red main.** If `main` is red, fix it or report it
   first. A PR merged into a red main inherits failures that are not its own,
   and the next agent chases them.
7. **Answer every review thread in one pass.** `main` requires resolved
   threads (`required_review_thread_resolution`). Read all bot findings,
   verify them, and fix or answer each one before asking for a merge.
   Fixing one thread per CI round multiplies the rounds.
8. **A slow test is not a flake.** A file that is killed at the 90 s
   per-file cap while still working goes into `HEAVY_FILES` in
   `scripts/run-test-shard.js`, with the reason. Rerunning until it passes
   moves the red to the next PR.

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

## 10. No AI Attribution (signature ban)

Forbidden in every artifact that leaves the agent — issues, pull requests,
review comments, ordinary comments, commit messages, PR descriptions:

* any AI signature or disclosure line (for example “created by an AI agent”,
  “AI ajanı tarafından oluşturuldu”, “on behalf of …”, or any OpenHands /
  agent name);
* the commit trailer `Co-authored-by: openhands <openhands@all-hands.dev>`
  or any equivalent agent co-author / author trailer;
* any auto-generated footer added by a tool to a body or comment.

The work is presented as the repository owner's own. Never write an AI/agent
name, an “on behalf of” phrase, or an agent co-author trailer into GitHub or
into git.

If an artifact already carrying such a line is touched, remove the line as part
of the task.

Rewriting existing history to strip such a trailer is a separate, destructive
operation: do it only with explicit approval (see section 4).

## 11. Cognitive Architecture Program (COG)

Any change under `lib/cognition/`, or to `lib/cognitive-scheduler.js`,
`lib/agent-step-progression.js`, `lib/dream-experiment-loop.js`,
`lib/agent-v3-dream-loop-adapter.js`, `lib/memory-consolidation.js`,
`lib/experience/coder-routing-runtime.js` or the `opts.cognition` seam in
`agent.v3.js`, belongs to the COG program.

1. Read `docs/cognitive-architecture-plan.md` and find the matching
   `[COG-Mx]` issue in the Project before starting. No COG work without an
   issue; continue an existing PR instead of opening a parallel one.
2. COG modules never gain action authority. They score, rank or propose.
   The firewall, risk classifier, approval runtime and reflective-promotion
   admission keep the last word. Mutation only through
   `Graph.runMutationOnce` with a receipt.
3. `lib/cognition/*` is pure, deterministic and Core-ring: no `fs`, network,
   graph or kernel imports, no `Date.now`/`Math.random`.
4. Every module ships opt-in and enters `NOT_YET_WIRED`; it leaves the ledger
   in the PR that wires it. It becomes a default only after a preregistered
   Cognitive Lab paired-delta reports `assertsGain: true`.
5. PRs that change `config/reachability-baseline.json` are serialized; check
   the Project `Ledger kilidi` field first and set it while your PR is open.

## 12. Smallest Complete Change

Solve the whole task with the least new code. Read the task and the code it
touches first, and list every place the change must reach: callers, tests,
fixtures, config, exports. Then take the first option that fully works:

1. Does it need to exist? Skip what nobody asked for and name it in one line.
2. Already in this codebase (816 `lib/` modules)? Use it the way the
   surrounding code does. Search the graph before writing a helper.
3. Node standard library or a platform feature? Use it.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change: finish the callers,
  tests and fixtures it breaks.
- No abstraction, option, config or "for later" code nobody asked for. Keep
  the existing layers and conventions. Deletion beats addition.
- Bug fix: find every caller of the function first, then fix the root cause
  once in the shared code.
- New non-trivial logic leaves a test (section 7 and the TDD rules still
  apply in full).
- A shortcut with a known limit gets `// shortcut: <limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data
loss, security, fail-closed behaviour, anything the task asked for.
Adapted from Ponytail (github.com/DietrichGebert/ponytail, MIT).
