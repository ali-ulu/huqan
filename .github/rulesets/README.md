# HUQAN Ruleset Import Recipes

These files are intended for GitHub's native:

Settings -> Rules -> Rulesets -> New ruleset -> Import a ruleset

## Files

- `main-branch.json` and `huqan-main-ruleset.json` both protect `main`. They are
  the same ruleset under two names and are kept byte-identical:
  `test/github-main-ruleset.test.js` fails if they diverge.
- `release-tags.json` and `huqan-release-tags-ruleset.json` both protect release
  tags matching `v*`, again as a kept-in-sync pair.

## Why the main ruleset uses 0 required approvals

HUQAN is currently maintained primarily by a solo maintainer. Requiring one
approval would make the pull request author depend on a second human account and
would block normal self-maintained work.

The ruleset still requires:

- pull requests;
- all 13 current required GitHub Actions checks;
- review-thread resolution;
- an up-to-date branch before merge;
- no force-push;
- no deletion.

If a second regular maintainer joins, `required_approving_review_count` can be
raised to 1.

## Status checks

The check names and GitHub Actions integration id were copied from the live
`main` protection state on 2026-09-18. If GitHub rejects a stale check during
import, select the current equivalent check in the review screen rather than
guessing a renamed context.

## Architecture checks are consolidated

`.github/workflows/architecture.yml` runs the architecture gates as two jobs,
`Architecture static gates` and `Architecture source gates`, instead of one job
per check. This recipe already lists those two consolidated contexts in place of
the seven legacy per-check names.

The live `main` ruleset and classic branch protection still require the seven
legacy names. Seven compatibility jobs in `architecture.yml` keep producing them
so the required contexts stay real during the migration. Remove those compat jobs
only after both live layers drop the legacy names -- otherwise merges stall.

## Migration safety

Classic branch protection and Rulesets layer together and the main Ruleset is
`active`. Import in `evaluate` mode first so Rule Insights can show what it would
block without changing merge behavior; after one representative test PR behaves
as expected, switch it to `active`. Only remove classic branch protection after
the active Ruleset proves equivalent or stronger enforcement.

## Release tags

The tag ruleset prevents deletion and non-fast-forward updates of `v*` tags.
It intentionally does not block creating a new release tag because the existing
publish workflow requires maintainers to create a matching immutable
`v<package version>` tag.


## Signed commits evaluation

The main ruleset recipe also includes `required_signatures`. Because the
ruleset starts in `evaluate` mode, use Ruleset Insights to confirm that normal
GitHub web merges, squash merges, and the repository's automation produce
verified commits before switching enforcement to `active`.

If legitimate merge paths would be blocked, remove or defer this rule rather
than adding a broad bypass actor. The goal is stronger provenance, not a hidden
escape hatch.
