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
