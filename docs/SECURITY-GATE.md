# AXIOM Security Gate

This document defines the mandatory pre-merge security gate for AXIOM.

Every PR must be checked against these categories before merge.

## 1. Public Endpoint Exposure

Check whether the PR touches:

- `server.js`
- `requestGuards.js`
- route handlers
- API endpoints
- CLI command routing exposed through HTTP

Questions:

- Is a local-only command exposed through public HTTP?
- Can the endpoint mutate graph, memory, audit, provenance, candidate claims, or filesystem state?
- Is the endpoint intentionally public?
- Does it need API key protection?
- Does it need explicit denylist / allowlist behavior?

Known sealed examples:

- PR-S0 blocked `restore`, `yükle`, `yukle`, and bare `restore` from public `/api`.
- PR-S0b made missing `AXIOM_API_KEY` fail closed.

## 2. Auth / Authorization

Check:

- Does the endpoint call `requireApiKey` / `denyIfUnauthorized` when required?
- What happens if `AXIOM_API_KEY` is missing?
- What happens if it is empty or whitespace?
- Are tests covering:
  - valid key
  - invalid key
  - missing key
  - unauthenticated request?

Rule: Guarded endpoints must fail closed.

## 3. Filesystem and Process Safety

Check:

- Does user input reach `fs.readFileSync`, `fs.writeFileSync`, restore/import/export paths, or shell commands?
- Is the path confined to an allowlisted root?
- Are dangerous commands blocked from HTTP?
- Does the code avoid broad process-kill behavior?

Forbidden without explicit approval:

- arbitrary local file reads from public endpoints
- arbitrary restore path from public endpoints
- shell command execution from user input
- broad `taskkill /F /IM node.exe`

## 4. Trust Boundary

Check:

- Can user/agent/LLM input enter canonical graph directly?
- Can untrusted input change provenance, audit, trust policy, workspace, or candidate status?
- Does flagged or rejected data stay out of active graph?
- Does the PR preserve canonical graph admission rules?

## 5. Test Coverage

For each security-relevant behavior, tests must include:

- positive allowed path
- negative denied path
- regression for the specific bug class
- no mutation side effect where relevant

Examples:

- `/api?q=restore:foo` returns 403
- `/api?q=yükle:/etc/passwd` returns 403
- missing `AXIOM_API_KEY` returns 401
- valid authenticated request still works

## 6. Merge Decision Rule

A PR is merge candidate only if:

- security gate has no open blocker
- `npm test` passes
- targeted tests pass when relevant
- changed files match declared scope
- `package-lock.json` drift is understood
- untracked files are not staged
- no unrelated drift is included

If any security finding exists:

- stop
- report the finding
- do not merge
- do not push to main
- fix in the same PR only if scope-approved
