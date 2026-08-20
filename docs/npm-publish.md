# Publishing `huqan` to npm

**Status:** implementation

**About:** `main` at the commit that introduced this page, with
`package.json` at version 0.10.0 and the package not yet on the registry.

`huqan` has never been published — `npm view huqan` answers 404 — so the first
publish is the one that decides what the name means. This page is the runbook:
what the repository already checks for you, what only a human with the npm
account can do, and how to tell afterwards whether it worked.

## What runs automatically

`npm publish` triggers `prepublishOnly`, which is:

```
npm run check:package-closure && npm test
```

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

1. **Be on a clean `main`.** The version in `package.json` is what gets
   published; there is no tag-driven release job.

   ```bash
   git checkout main && git pull && git status --porcelain
   ```

2. **Decide the version.** `npm publish` refuses to overwrite an existing
   version, and npm only allows unpublishing within 72 hours of a publish, and
   only while nothing depends on it. Treat the number as permanent.

3. **Rehearse the tarball.** This is the step that catches what tests do not:

   ```bash
   npm pack --pack-destination /tmp/huqan-rehearsal
   mkdir -p /tmp/huqan-consumer && cd /tmp/huqan-consumer && npm init -y
   npm install /tmp/huqan-rehearsal/huqan-<version>.tgz
   ./node_modules/.bin/huqan quickstart
   ```

   Read the output, do not just check the exit code. A plugin or adapter that
   fails to load prints a line and the run still succeeds — that line is the
   defect. A good run ends with a Trust Receipt at confidence 0.90 and no
   `Plugin failed to load` or `Cannot find module` anywhere above it.

4. **Rehearse the slim install too.** `pdfjs-dist` and `pdfkit` are optional
   dependencies, so `--omit=optional` is a supported shape (about 20 MB instead
   of about 111 MB) and needs to keep working:

   ```bash
   npm install /tmp/huqan-rehearsal/huqan-<version>.tgz --omit=optional
   ```

   Same quickstart, same receipt. PDF ingest and PDF receipt export are the
   only things that may fail, and they must fail as
   `HUQAN_PDF_EXPORT_UNAVAILABLE` naming the package to install, not as a
   module-not-found.

5. **Check the MCP executable answers**, since it is what every editor
   integration starts:

   ```bash
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rehearsal","version":"1"}}}' \
     | ./node_modules/.bin/huqan-mcp
   ```

   Expect `"serverInfo":{"name":"huqan","version":"<version>"}`.

## Publishing

Only the npm account owner can do this part; it needs a login and, if the
account has 2FA on publishes, a one-time code at the prompt.

```bash
npm whoami          # confirm which account you are about to publish as
npm publish
```

The package is unscoped and public, so no `--access` flag is needed. The
license is `AGPL-3.0-only`; npm shows it on the package page, and that is the
license the first publish establishes for everyone who installs.

**Consider `--tag next` for the first publish.** It uploads the version without
moving the `latest` tag, so `npm install huqan` keeps returning nothing while
`npm install huqan@next` gets the real thing. That buys a round of real-world
verification before the name starts serving strangers:

```bash
npm publish --tag next
# ... verify ...
npm dist-tag add huqan@<version> latest
```

`--provenance` is not available from a laptop: it requires a CI runner with an
OIDC identity. Publishing without it is normal for a first release; wiring a
publish workflow is a separate decision.

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
