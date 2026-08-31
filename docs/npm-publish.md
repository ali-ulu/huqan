# Publishing `huqan` to npm

**Status:** implementation + release runbook

**Source reality at this revision:** `package.json` is `0.11.1`; the latest
stable GitHub Release is `v0.10.0`. Existing version/tag state must be checked
again immediately before any publication because npm versions and Git tags are
immutable release identities.

`huqan` is already public on npm. Every later publish therefore changes what
existing installs can upgrade into. Never edit or repoint an already-published
version/tag to make it represent newer code; publish a new version instead.

## What the repository checks

`package.json#prepublishOnly` intentionally runs only:

```bash
npm run check:package-closure
```

The CI publish workflow performs the expensive gates as explicit steps before
`npm publish`:

1. require an immutable `v<version>` tag;
2. require the tag name to match `package.json#version` exactly;
3. require the tagged commit to be an ancestor of the default branch;
4. refuse a version that already exists on npm;
5. run `npm ci --include=optional`;
6. run `npm run verify:tarball` against a clean installed consumer;
7. run the full `npm test` suite;
8. publish with npm provenance only after all gates pass.

The full test suite is deliberately not nested inside `prepublishOnly`.
Installed-package tests themselves invoke npm pack/install operations, and
running them from inside an outer `npm publish` contaminates those nested npm
processes. `.github/workflows/publish.yml` is the authoritative orchestration.

## Before you publish

1. **Start from reviewed `main`.** Confirm the intended commit and that the
   release version is not already published.

   ```bash
   git checkout main
   git pull
   git status --porcelain
   npm view huqan versions --json
   ```

2. **Choose a new immutable version.** Do not reuse or move an existing tag.
   In particular, a historical `v0.11.0` tag remains the identity of the commit
   it already points to; newer launch hardening must ship under a newer version.

3. **Rehearse the exact tarball.**

   ```bash
   npm run verify:tarball
   ```

   This packs the current source and installs it into empty consumers so the
   package is tested as a user receives it rather than through paths available
   only in a clone. It verifies both normal install and the documented
   optional-dependency boundary.

4. **Run the launch installed-package smoke for a launch release.** The launch
   gate exercises the actual installed CLI, MCP and local server paths and is
   separate from unit/source tests.

## GitHub Environment: `npm-publish` (#1690)

The workflow already declares:

```yaml
jobs:
  publish:
    environment: npm-publish
```

That declaration alone is **not** proof that the repository-side environment
policy is configured. GitHub can create an environment implicitly, and naming
an environment does not by itself restrict who may deploy to it.

Since the move to trusted publishing the environment is no longer only defense
in depth: **its name is half of the publish credential.** npm checks the
repository, the workflow filename and the environment name carried in the OIDC
claim against the trusted publisher configured on the package, so a job running
outside `npm-publish` cannot publish even from a valid release tag.

Before the next real npm publication, a repository administrator must verify
all of the following in **Settings -> Environments -> npm-publish**:

- the `npm-publish` environment exists intentionally;
- deployment branches/tags are restricted so only release `v*` tags can deploy;
- required reviewers are configured if a human publication gate is desired.

There is no `NPM_TOKEN` to scope any more. If one is still stored — repository
secret or environment secret — delete it: it is now an unused long-lived write
credential for the package, which is strictly worse than having none.

The workflow's own tag/version/default-branch checks remain mandatory even when
the environment is configured. They are an independent release authority, not a
restatement of the credential.

## npm trusted publisher (one-time, on npmjs.com)

The workflow authenticates over OIDC and stores nothing, but that only works
once the package itself names this workflow as a trusted publisher. Until it
does, every release fails at the upload step — and it fails as an HTTP 404
naming the package, because npm answers an unauthorized `PUT` with 404 rather
than 403. The message reads `'huqan@x.y.z' is not in this registry`, which
looks like a registry problem and is in fact a credential problem. Runs
33342689402, 33343813607 and their four predecessors all died exactly here,
with every release gate already passed.

On **npmjs.com → the `huqan` package → Settings → Trusted Publisher**, add a
GitHub Actions publisher with exactly:

```text
Organization or user: ali-ulu
Repository:           huqan
Workflow filename:    publish.yml
Environment:          npm-publish
```

All four must match the workflow, the environment name included. A mismatch in
any one of them produces the same 404 as having configured nothing at all.

### How to verify the setup

Do not close #1690 from source review alone. Record repository-admin evidence
showing the environment policy and the trusted-publisher entry.

A safe verification record contains only facts such as:

```text
Environment: npm-publish
Deployment policy: protected/restricted to release v* tags
Required reviewers: configured / intentionally not configured
Trusted publisher on npm: ali-ulu/huqan, publish.yml, env npm-publish
Stored NPM_TOKEN: none (removed)
Verified by: <admin>
Verified at: <timestamp>
```

Then run the publish workflow manually from the intended release tag with
`dry_run` left enabled. A dry run passes every release gate without uploading,
so it proves the gates and the tag binding — but **not** the credential: the
OIDC exchange only happens at the upload npm dry runs withhold. The trusted
publisher entry must therefore still be checked on npmjs.com.

## Publishing from CI (preferred)

`.github/workflows/publish.yml` is tag-driven and authenticates with GitHub's
OIDC identity rather than a stored token: npm mints a short-lived, single-upload
credential after checking the claim against the package's trusted publisher.
Provenance is attested automatically, so the workflow passes no `--provenance`
flag. Nothing is stored, so nothing expires and nothing has to be rotated.

For a release after the version decision is reviewed:

```bash
npm version <patch|minor|major>
git push --follow-tags
```

Do this only when creating the tag is the intended release action. A Product
Hunt launch candidate should first finish its exact installed-package smoke;
creating a tag is not a substitute for that smoke.

A manual workflow dispatch is useful for rehearsal. Real publication still
requires an immutable release tag whose name matches the manifest and whose
commit is on the default branch.

## Publishing from a laptop

A direct laptop publish works but does not provide the GitHub Actions provenance
attestation and bypasses the repository's environment defense in depth. Prefer
CI for normal releases.

If emergency/manual publication is deliberately chosen:

```bash
npm whoami
npm publish --access public
```

Use the same version, tarball and test discipline as CI. Never use a laptop
publish to work around a failing release gate.

For a deliberately staged non-security release, `--tag next` can keep `latest`
on the existing stable version while the new version is verified:

```bash
npm publish --tag next --access public
# verify the exact published version externally
npm dist-tag add huqan@<version> latest
```

Moving `latest` is itself a release action and must be deliberate.

## After publishing

Verify from outside the repository in a directory with no clone-local
`node_modules`:

```bash
npm view huqan version
cd "$(mktemp -d)"
npx -y huqan quickstart
npx -y --package=huqan huqan-mcp < /dev/null
```

The `--package=huqan` form matters because the executable is named
`huqan-mcp` while the npm package is named `huqan`.

Also inspect the rendered npm package page for the expected README, license,
version, provenance and file list, and compare the published version with the
Git tag and GitHub Release identity.

## Known release boundaries

- npm versions are immutable release identities; fix mistakes with a new
  version rather than trying to overwrite one.
- `better-sqlite3` is a required native dependency. A platform with no matching
  prebuilt binary may need a C++ toolchain.
- A passing source/unit suite is not a clean installed-package launch proof.
- A workflow line saying `environment: npm-publish` is not evidence that #1690
  is closed; repository-side environment policy and secret scope must be
  verified separately.
