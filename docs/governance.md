# Governance

HUQAN is currently maintainer-led.

Canonical repository: `https://github.com/ali-ulu/huqan`

Some internal files and compatibility identifiers retain the historical AXIOM name. The public project and repository identity is HUQAN.

This is the honest operating model:

- A human maintainer reviews and approves merges.
- AI-assisted code and documentation are allowed, but they are not self-approved.
- Scoped pull requests are preferred over broad branch rewrites.
- Security-sensitive changes require explicit approval.
- Release tags require clean test and smoke gates.
- Auto-merge is not part of the canonical release path.

## What this project is not claiming

- not a large multi-maintainer foundation project
- not community-governed in the formal sense
- not fully automated review
- not AI self-approval of code
- not release-by-default

## Contribution workflow

1. Clone `https://github.com/ali-ulu/huqan.git`.
2. Open a scoped branch.
3. Make one clear change set.
4. Run the relevant tests and checks.
5. Include exact evidence in the pull request.
6. Wait for human review.

## Security and release

- Security issues are reported through [SECURITY.md](../SECURITY.md).
- Release work uses explicit gates and clean verification.
- If a change touches security, release, or trust behavior, do not assume merge readiness without review.

## Continuity and independent review

HUQAN currently has a single accountable maintainer. That is a known continuity
risk, not a claim that automation or an AI agent replaces independent human
oversight. Until a co-maintainer is appointed, this policy defines the minimum
evidence required for sensitive changes and for a future handover.

- Changes to `lib/` gates, approvals, receipts, authentication, mutation
  journals, release configuration, and CI require review by a second human
  with repository access before merge. If no second reviewer is available, the
  PR remains open rather than treating its author or an AI check as approval.
- A release requires a named human release owner, a clean protected branch,
  green required checks, and a tag or package signature attributable to that
  owner. The release record must link the reviewed PRs and verification output.
- Repository access, package-publishing access, release-signing keys, and CI
  secrets must have an owner and a documented recovery path. Secrets themselves
  are never stored in this repository.
- A continuity handover consists of the canonical repository URL, current
  protected-branch settings, maintainer/reviewer access list, release procedure,
  recovery contacts, and the latest release evidence. It is reviewed whenever a
  maintainer changes and at least once per release cycle.

## AI-assisted changes

AI-assisted commits are treated as proposed changes, not as reviewers or
approvers. Their PRs must state the affected scope, tests run, CI result, and
any remaining uncertainty. A human reviewer verifies the diff and evidence;
the authoring tool's self-report is not merge evidence. This keeps the project
honest about its current bus factor while making review and handover auditable.
