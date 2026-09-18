# GitHub Platform Governance

This document records the intended GitHub-level controls around HUQAN and the
last verified live baseline. It complements repository code and CI; it does not
replace them.

## Repository features

The repository uses:

- Issues for reproducible defects and scoped engineering work;
- Discussions for questions and exploratory design conversations;
- Projects for planning and execution views;
- Wiki-oriented documentation under `docs/wiki/` for long-form orientation;
- Actions for test, architecture, benchmark, security, conformance, launch-smoke,
  publishing, and governance checks;
- Releases for tagged public artifacts;
- Dependabot for dependency update automation.

Repository metadata currently reports Issues, Projects, Wiki and Discussions as
enabled.

Repository-native collaboration metadata also includes:

- structured Bug and Feature issue forms;
- a pull request template with HUQAN trust/security checks;
- Ideas and Q&A Discussion category forms for the default `ideas` and `q-a`
  category slugs;
- `.github/release.yml` categories for GitHub-generated release notes;
- `CITATION.cff`, which lets GitHub expose **Cite this repository**.

## Verified main-branch protection

Live repository inspection on 2026-09-18 reports `main` as protected.

The protection currently requires these GitHub Actions checks for non-admin
merges:

- `npm test gate`
- `Conformance Gate`
- `Validate BDD/Gherkin contracts`
- `Security Checks`
- `Workflow governance`
- `Forbid raw control characters in tracked sources`
- `Require living documentation to agree with the source`
- `Require graph is acyclic`
- `Require every V5 document to declare its status`
- `Enforce the large-file threshold`
- `Enforce a lint-clean tree`
- `Require architecture tracker snapshot to be current`

The repository Rulesets collection currently returns an empty list, so the
observed enforcement is classic branch protection rather than a repository
Ruleset.

That distinction is operational, not semantic: the required checks are real and
`main` is protected. A future migration to Rulesets should preserve at least
the same enforcement before the classic rule is removed.

The installed GitHub integration does not expose enough branch-protection admin
detail to independently verify every setting such as force-push, deletion,
required review count, conversation resolution, or admin bypass. Those remain
live-settings audit items.

## Main branch target

Whether implemented through classic branch protection or Rulesets, the target
remains:

- pull request required before merge;
- force pushes blocked;
- branch deletion blocked;
- controlling test/security/architecture/conformance checks required;
- branch freshness required where stale-base execution can invalidate evidence;
- conversation resolution required when review threads exist;
- bypass kept minimal and explicit.

Do not remove working classic protection merely to obtain a newer UI primitive.
Migrate only when equivalent behavior is confirmed.

## Release tag ruleset target

Release tags matching `v*` should be protected from deletion or replacement
once published.

Release authority remains defined by `.github/workflows/publish.yml`:

- publication is tag-bound;
- the `v<version>` tag must match `package.json`;
- the tagged commit must be reachable from the default branch;
- publication uses the `npm-publish` environment;
- npm publishing uses GitHub OIDC trusted publishing rather than a stored
  `NPM_TOKEN`;
- release artifacts include npm provenance, and the workflow produces a
  CycloneDX SBOM.

Tag protection is still a GitHub-settings control and must not weaken those
workflow-level checks.

## Security target

Repository code already carries:

- CodeQL with the `security-extended` query suite;
- fail-closed `npm audit --audit-level=high`;
- Gitleaks secret scanning in CI;
- Semgrep JavaScript and secrets rules;
- SHA-pinned GitHub Actions enforced by workflow-governance checks;
- weekly Dependabot version updates for npm and GitHub Actions;
- `SECURITY.md` and `THREAT_MODEL.md`.

Live GitHub settings should additionally retain or enable where available:

- GitHub Private Vulnerability Reporting;
- Dependabot alerts;
- Dependabot security updates;
- native secret scanning;
- native push protection;
- CodeQL/code-scanning alert publication.

CI secret scanning and native GitHub push protection are complementary. One
must not be treated as evidence that the other is enabled.

## Actions permissions

The target is least privilege:

- repository default `GITHUB_TOKEN` permissions read-only where practical;
- write permissions declared per job only when required;
- third-party Actions pinned to immutable commit SHAs;
- fork-PR execution/approval policy intentional;
- privileged release authority isolated from ordinary PR jobs.

## Release environment

The `npm-publish` environment is part of release authority and is referenced
directly by `.github/workflows/publish.yml`.

The live environment should remain:

- dedicated to release publishing;
- limited to intended `v*` release refs;
- free of an alternate long-lived `NPM_TOKEN` path while OIDC trusted
  publishing is authoritative;
- inaccessible to unrelated workflows.

Any required reviewers or wait timers should represent an intentional release
control, not ceremony.

## GitHub Pages / static demo

`demo/index.html` now exists and is explicitly backend-free, so HUQAN has a
valid candidate for a repository-native GitHub Pages demo.

Repository metadata currently reports GitHub Pages as disabled. Enabling Pages
is optional and should publish only the static demo/docs surface, never the
backend-connected local UI or imply a live HUQAN runtime deployment.

If Pages is enabled, deployment configuration should preserve:

- no secrets;
- no API key;
- no backend dependency;
- explicit `static simulation` labeling;
- least-privilege Pages workflow permissions.

## Projects

GitHub Projects is enabled for the repository. The installed connector does not
expose Project board items or fields, so board content cannot be independently
audited from this automation surface.

A separate native GitHub Milestone is verified:

- milestone #1: **HUQAN 100**;
- description: repository-engineering improvements under developer control;
- observed on 2026-09-18 with 30 open issues and 0 closed issues;
- no due date is set.

Milestones and Projects are different layers: the milestone groups bounded work
toward one objective, while the Project may provide status/priority views over
the same durable Issues.

The desired project model is:

- Issues remain the durable unit of engineering work;
- the Project provides views, status and prioritization rather than becoming a
  second source of truth;
- completed project items should resolve to closed/merged GitHub objects;
- speculative ideas belong in Discussions until they are scoped enough to
  become Issues.

## Pull request policy

Repository PRs use `.github/PULL_REQUEST_TEMPLATE.md` and should preserve these
invariants when relevant:

- a proposing model cannot approve its own governed mutation;
- unknown or malformed security-sensitive input fails closed;
- receipt/provenance integrity is not weakened;
- workspace/path/authority boundaries remain explicit;
- public surface changes include compatibility and release impact.

## Issue routing

- bugs -> Bug report form;
- bounded capabilities -> Feature request form;
- questions and early design -> Discussions;
- sensitive vulnerabilities -> private vulnerability process in `SECURITY.md`.

## Merge policy

The repository currently permits squash merges and merge commits, disables
rebase merges, enables auto-merge, and deletes merged branches automatically.

If merge commits remain enabled, use them deliberately for cases where preserving
branch topology matters; otherwise normal scoped changes should prefer the
repository's chosen canonical merge style consistently.

## Audit rule

GitHub UI settings are live configuration and may drift from this document.
When they disagree, inspect the live repository settings and current Actions
behavior before making a claim.

Evidence from a configured workflow file proves what the workflow intends to do.
Evidence from a GitHub setting proves what GitHub currently enforces. Keep those
two evidence classes separate.
