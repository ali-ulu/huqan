# Publishing `huqan` to npm

**Status:** implementation

**About:** `main` at the commit that revised this page, with `package.json` at
version 0.10.1 and v0.10.0 on the registry since 2026-08-27.

`huqan` is published: `npm view huqan version` answers, and `npm install -g
huqan` reaches real users. That changes what this runbook is for. The first
publish decided what the name means; every publish after it decides what
existing installs upgrade into, and npm allows unpublishing only within 72
hours and only while nothing depends on the version. This page is the runbook:
what the repository already checks for you, what only a human with the npm
account can do, and how to tell afterwards whether it worked.

> A published version is never edited in place. If something is wrong with what
> is on the registry, the fix is a new version — see #1688 for the security
> release that motivated this revision.

## What runs automatically

`npm publish` triggers `prepublishOnly`, which is:

```
npm run check:package-closure && npm test
```

and `npm run verify:tarball` covers the half those two cannot reach. The CI
workflow runs the tarball verification explicitly and lets `npm publish` run
the other two, so the halves do not overlap: one proves the source tree is
sound, the other proves the tarball behaves.

Those two cover the failure this repository has actually shipped. In v0.10.0,
three modules the installed package loads at require time were missing from
`package.json#files`, so the tarball threw `Cannot find module` from inside
`node_modules` while every path still resolved from a clone.
`scripts/check-package-closure.js` walks load-time requires outward from
`main`, every declared `bin`, and each published plugin and adapter, and fails
when one of them is not published.

What it does **not** cover: whether the tarball behaves once installed. A
module can be present and still be wrong. The smoke below is the part no static
check replaces.

## Before you publish

1. **Be on a clean `main`.** `package.json#version` is what gets published; the
   tag has to agree with it, and CI additionally requires the tagged commit to
   be an ancestor of `main` (#1673), so a tag on an unmerged commit is refused.

   ```bash
   git checkout main && git pull && git status --porcelain
   ```

2. **Decide the version.** `npm publish` refuses to overwrite an existing
   version, and npm only allows unpublishing within 72 hours of a publish, and
   only while nothing depends on it. Treat the number as permanent. Check what
   is already there first — `npm view huqan versions` — since the workflow's
   "Refuse to republish an existing version" step will stop a publish that
   forgets to bump.

3. **Rehearse the tarball.** This is the step that catches what tests do not:

   ```bash
   npm run verify:tarball
   ```

   It packs the package, installs it into an empty project twice -- once
   normally and once with `--omit=optional`, since both are documented install
   shapes -- and checks each one: both bins present, `huqan --version` correct,
   `huqan quickstart` producing a canonical Trust Receipt, and `huqan-mcp`
   answering `initialize` and listing its tools.

   The reason it reads output rather than exit codes: a plugin or adapter that
   fails to load prints a line and the run still exits 0. That line is the
   defect. `scripts/verify-package-tarball.js` fails on `Plugin failed to
   load`, `Cannot find module` and `MODULE_NOT_FOUND` anywhere in the
   quickstart output, which is exactly how v0.10.0's three unpublished modules
   would have been caught.

   PDF ingest and PDF receipt export are the only things allowed to be
   unavailable under `--omit=optional`, and they must fail as
   `HUQAN_PDF_EXPORT_UNAVAILABLE` naming the package to install, not as a
   module-not-found.

## Publishing from CI (preferred)

`.github/workflows/publish.yml` publishes on a `v*` tag, and it is the better
path for one reason a laptop cannot match: `--provenance`. npm exchanges the
workflow's OIDC token for a signed attestation tying the tarball to this
repository, this workflow and this commit, and shows it on the package page.
For a product whose claim is verifiable provenance, publishing unattested is a
poor first impression.

**One-time setup.** Create an npm access token of type **Automation** (it
bypasses 2FA, which is what lets CI publish while your account keeps 2FA on),
then add it as `NPM_TOKEN`. The job declares `environment: npm-publish`, so the
token belongs on that environment rather than at repository scope: an
environment secret is unreachable from any other workflow, and the
environment's deployment-branch policy can be restricted to `v*` tags so a
dispatch from a branch cannot reach it at all. See #1690 for the repository-side
setup, which is admin-only and not enforced by anything in this repository.

**Every release after that:**

```bash
npm version <patch|minor|major>   # bumps package.json and creates the v<x> tag
git push --follow-tags
```

The workflow refuses to proceed unless the ref is an immutable `v*` tag whose
name matches `package.json#version` and whose commit is an ancestor of the
default branch, and it refuses if that version is already on the registry. The
same checks run for a manual dispatch — there is no branch path to the publish
step (#1673).

To exercise every gate without uploading, run the workflow manually from the
Actions tab with **dry_run** left checked.

## Publishing from a laptop

Works, and produces no provenance attestation. It needs a login and, if the
account has 2FA on publishes, a one-time code at the prompt.

```bash
npm whoami          # confirm which account you are about to publish as
npm publish
```

The package is unscoped and public, so no `--access` flag is needed. The
license is `AGPL-3.0-only`; npm shows it on the package page, and that is the
license established for everyone who installs.

**Consider `--tag next` for a risky release.** It uploads the version without
moving the `latest` tag, so `npm install huqan` keeps serving the current
`latest` while `npm install huqan@next` gets the new build. That buys a round of
real-world verification before existing installs upgrade into it. It is the
wrong choice for a security release, where the point is that `latest` stops
being the vulnerable version:

```bash
npm publish --tag next
# ... verify ...
npm dist-tag add huqan@<version> latest
```

## After publishing

Verify from outside the repository, in a directory with no `node_modules` and
no clone:

```bash
npm view huqan version
cd $(mktemp -d)
npx -y huqan quickstart
npx -y --package=huqan huqan-mcp < /dev/null
```

The `--package=huqan` is not optional and not cosmetic: the bin is named
`huqan-mcp` while the package is named `huqan`, so `npx huqan-mcp` looks for a
package that does not exist. This is the exact string the README gives editors,
so a failure here is a failure of the documented setup.

Then check the rendered package page for the README, the license and the file
list at `https://www.npmjs.com/package/huqan`.

## Known limits of what you are publishing

- `POST /api/a2a/exchange` cannot be enabled from an install. It reaches the V5
  cryptographic family, which `package.json#files` deliberately does not
  publish, so the route stays 404 there however it is configured. The other
  three A2A routes do turn on. See `README.md` and `docs/a2a-deployment.md`.
- `better-sqlite3` is a required dependency and a native addon. On a platform
  with no prebuilt binary the install needs a C++ toolchain. `lib/sqlite-availability.js`
  turns the two failure modes — never installed, versus installed against a
  different Node ABI — into different messages, because the fix differs.
