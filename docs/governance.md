# Governance

AXIOM / HUQAN is currently maintainer-led.

This is the honest operating model:

- A human maintainer reviews and approves merges.
- AI-assisted code and docs are allowed, but they are not self-approved.
- Scoped PRs are preferred over broad branch rewrites.
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

1. Open a scoped branch.
2. Make one clear change set.
3. Run the relevant tests.
4. Include the test result in the PR.
5. Wait for human review.

## Security and release

- Security issues are reported through [SECURITY.md](../SECURITY.md).
- Release work uses explicit gates and clean verification.
- If a change touches security, release, or trust behavior, do not assume merge readiness without review.