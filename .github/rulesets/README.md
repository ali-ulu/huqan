# HUQAN Ruleset Import Recipes

These files are intended for GitHub's native:

Settings -> Rules -> Rulesets -> New ruleset -> Import a ruleset

## Files

- `main-branch.json` protects `main`.
- `release-tags.json` protects release tags matching `v*`.

## Why the main ruleset uses 0 required approvals

HUQAN is currently maintained primarily by a solo maintainer. Requiring one
approval would make the pull request author depend on a second human account and
would block normal self-maintained work.

The ruleset still requires:

- pull requests;
- all 12 current required GitHub Actions checks;
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

## Migration safety

Classic branch protection and Rulesets layer together. Import and verify the new
ruleset first. Only remove classic branch protection after a test PR proves that
the native Ruleset provides equivalent or stronger enforcement.

## Release tags

The tag ruleset prevents deletion and non-fast-forward updates of `v*` tags.
It intentionally does not block creating a new release tag because the existing
publish workflow requires maintainers to create a matching immutable
`v<package version>` tag.
