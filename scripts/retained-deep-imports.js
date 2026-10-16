'use strict';

/**
 * The deep imports this package promises to keep working.
 *
 * `package.json` declares no `exports` map, so Node resolves any published path
 * an installed consumer names. That makes the *supported* surface a decision
 * rather than a consequence, and this file is where the decision is written
 * down: `main` and the `bin` targets, plus the modules callers were told they
 * could require directly.
 *
 * Two gates read it, and they must read the same list:
 *
 *   - `scripts/check-package-closure.js` walks the load-time requires outward
 *     from each of these and fails when one reaches a file `files` does not
 *     publish.
 *   - the 4C1 tarball smoke in `test/kernel-facade-contract.test.js` requires
 *     each one out of a real installation.
 *
 * They were separate lists until `lib/http/external-action-receipt-collector-route.js`
 * shipped unpublished: the smoke test caught it, the closure gate did not,
 * because `server.js` is a supported import that nothing reachable from
 * `index.js` requires. A surface only one of the two gates knows about is a
 * surface that breaks between releases.
 *
 * Adding an entry here is a promise; removing one is a breaking change.
 */
const RETAINED_DEEP_IMPORTS = Object.freeze([
  Object.freeze({ specifier: 'huqan', file: 'index.js', extensionless: false }),
  Object.freeze({ specifier: 'huqan/kernel', file: 'kernel.js', extensionless: true }),
  Object.freeze({ specifier: 'huqan/kernel.v2', file: 'kernel.v2.js', extensionless: true }),
  Object.freeze({ specifier: 'huqan/cli', file: 'cli.js', extensionless: true }),
  Object.freeze({ specifier: 'huqan/lib/sdk', file: 'lib/sdk.js', extensionless: true }),
  Object.freeze({ specifier: 'huqan/mcpServer', file: 'mcpServer.js', extensionless: true }),
  Object.freeze({ specifier: 'huqan/server', file: 'server.js', extensionless: true }),
  // Resolved through each package's own `main`, so there is no `.js` form.
  Object.freeze({ specifier: 'huqan/packages/huqan-verify', file: 'packages/huqan-verify/index.js', extensionless: false }),
  Object.freeze({ specifier: 'huqan/packages/axiom-verify', file: 'packages/axiom-verify/index.js', extensionless: false }),
]);

/**
 * The repo-relative files the retained surface resolves to.
 * @returns {string[]}
 */
function retainedDeepImportFiles() {
  return RETAINED_DEEP_IMPORTS.map(entry => entry.file);
}

/**
 * Every specifier an installed consumer may write, including the `.js` spelling
 * where Node accepts both. The smoke test exercises each one.
 * @returns {string[]}
 */
function retainedDeepImportSpecifiers() {
  const specifiers = [];
  for (const entry of RETAINED_DEEP_IMPORTS) {
    specifiers.push(entry.specifier);
    if (entry.extensionless) specifiers.push(`${entry.specifier}.js`);
  }
  return specifiers;
}

module.exports = {
  RETAINED_DEEP_IMPORTS,
  retainedDeepImportFiles,
  retainedDeepImportSpecifiers,
};
