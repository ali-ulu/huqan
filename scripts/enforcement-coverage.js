#!/usr/bin/env node
'use strict';

/**
 * What surface can actually act on the world, and which parts of it anybody has
 * looked at.
 *
 * The product's claim is that a risky action passes one admission boundary.
 * Nothing in the repository could answer "which risky actions are there?", so
 * the claim rested on a maintainer's memory, and a new adapter or a new
 * `child_process` call could join the surface without anyone noticing.
 *
 * WHAT THIS DOES NOT DO, stated first because the opposite would be worse than
 * having no manifest at all: it does not prove any call site is enforced.
 * Proving that statically would need call-graph analysis this repository has no
 * parser for -- there are no devDependencies, and the existing scanners
 * (check-package-closure, module-reachability) are hand-rolled for the same
 * reason. A manifest that inferred "guarded" from a require graph would report
 * coverage it had not established, which is precisely what #1815 was: a gate
 * that ran, passed, and measured the wrong thing.
 *
 * WHAT IT DOES: enumerate every call site that can execute a process, write to
 * the filesystem, or leave the machine, and require each one to be classified
 * by a human with a reason. An unclassified site fails the check. That is the
 * same shape as module-reachability's NOT_YET_WIRED list, and it is honest: the
 * inventory is mechanical, the judgement is recorded, and the unguarded surface
 * is listed rather than hidden.
 *
 * Binding-aware, because it has to be. A naive scan for `exec(` matches
 * `db.exec(` in five schema files and `regex.exec()` in two more -- it would
 * report SQLite DDL as unaudited process execution and bury the real sites in
 * noise. So the scanner resolves what each file actually bound from
 * `child_process`, `fs`, `http`/`https` and `net`, and only counts calls
 * through those bindings.
 *
 * KNOWN BLIND SPOTS: indirection defeats it, and dependency injection is
 * indirection's most ordinary form. The scanner follows a *local alias* of a
 * binding it already resolved -- `const f = fs;`, `const run = cp.spawnSync;`
 * -- and a default value in a function parameter or destructuring pattern
 * whose right-hand side is such a binding: `function f(root, fs = nodeFs)`,
 * `({ fileSystem = fs } = opts)`, `const { ..., fs = nodeFs, ... } = options;`.
 * The alias inherits the capability and the members list still decides which
 * calls count, so injecting a *read-only* handle stays invisible.
 *
 * What remains invisible: dynamic property access (`fs[name](...)`), and a
 * handle that arrives with no local binding to a known namespace -- an alias
 * created through an expression (a conditional, a map lookup, a value built
 * elsewhere and merely named at the call site). This is why the check demands
 * a human classification rather than claiming to be exhaustive.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CLASSIFIED } = require('./enforcement-coverage-classification');
// Binding/site scanning core lives in scripts/binding-site-scan.js (#2188);
// the scan-core names are re-exported below so existing importers keep working.
const {
  CAPABILITIES,
  bindingsFor,
  resolveBindings,
  stripComments,
  stripCommentsAndStrings,
  sitesIn,
} = require('./binding-site-scan');

const repoRoot = path.resolve(__dirname, '..');

// Scan core (CAPABILITIES/GLOBAL_EGRESS/blankRegions/bindingsFor/aliasesFor/
// resolveBindings/sitesIn) lives in scripts/binding-site-scan.js (#2188).

/**
 * Production JavaScript: what ships and runs, not tests, benchmarks or tooling.
 *
 * `public/` is browser code. It cannot spawn a process or write this machine's
 * disk, and its `fetch` is the operator's browser calling us, not this process
 * leaving the machine -- a different boundary, defended by CSP and the route
 * auth policy rather than by admission. It was never in this scan while it sat
 * inline in index.html; keeping it out is what holds this manifest's claim
 * about the *process* surface unchanged.
 *
 * It enumerates untracked files as well as tracked ones. A newly written file
 * that has not been `git add`ed yet is exactly the kind of file most likely to
 * hold an unclassified call site, and `git ls-files '*.js'` alone reported it
 * as absent rather than unclassified -- the scan passing for the reason that it
 * could not see the file. `--others --exclude-standard` keeps `.gitignore`
 * authoritative, so build output and local scratch stay out.
 *
 * `root` is injectable, defaulting to this repository, so a test can point the
 * scan at a temporary fixture.
 */
function productionFiles(root = repoRoot) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.js'],
    { cwd: root, encoding: 'utf8' },
  );
  return out.trim().split('\n').filter(Boolean).filter((file) => {
    if (/(^|\/)(test|benchmarks|scripts|public)\//.test(file)) return false;
    if (/\.test\.js$/.test(file)) return false;
    if (/(^|\/)node_modules\//.test(file)) return false;
    return true;
  });
}

function collectSites(root = repoRoot) {
  const sites = [];
  for (const file of productionFiles(root)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    sites.push(...sitesIn(file, source));
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/**
 * The inventory joined to its recorded judgement.
 *
 * `unclassified` is the failure. Everything else is reported, including the
 * sites deliberately outside the boundary -- listing them is the point.
 */
function buildCoverageManifest(root = repoRoot) {
  const sites = collectSites(root);
  const byFile = new Map();
  for (const site of sites) {
    if (!byFile.has(site.file)) byFile.set(site.file, []);
    byFile.get(site.file).push(site);
  }

  const entries = [];
  const unclassified = [];
  for (const [file, fileSites] of [...byFile].sort()) {
    const capabilities = [...new Set(fileSites.map((s) => s.capability))].sort();
    const classification = CLASSIFIED[file];
    if (!classification) {
      unclassified.push({ file, sites: fileSites.length, capabilities });
      continue;
    }
    entries.push({
      file,
      role: classification.role,
      why: classification.why,
      capabilities,
      sites: fileSites.map((s) => ({ line: s.line, capability: s.capability, call: s.call })),
    });
  }

  const byRole = {};
  for (const entry of entries) byRole[entry.role] = (byRole[entry.role] || 0) + entry.sites.length;
  const byCapability = {};
  for (const site of sites) byCapability[site.capability] = (byCapability[site.capability] || 0) + 1;

  return {
    schemaVersion: 'huqan.enforcement-coverage.v1',
    // Stated in the artifact, not only in this source, so a reader who only
    // ever sees the published manifest is not misled about what it establishes.
    //
    // The subprocess sentence is here rather than only in
    // docs/external-action-guard.md because that document does not ship: of the
    // whole docs/ tree, package.json#files publishes one seed file. A consumer
    // installs the package, gets this manifest, and would otherwise never meet
    // the boundary that decides what "protected" means.
    establishes: 'The inventory of call sites that can act on the world, and the recorded role of each. '
      + 'It does NOT establish that any site is enforced at run time: that would need call-graph '
      + 'analysis this build does not perform. A local alias, and a parameter or destructuring '
      + 'default whose right-hand side is a known binding, are followed; dynamic property access '
      + '(`fs[name](...)`) and a handle that is never locally bound to a known namespace are '
      + 'invisible to it. Nor does any entry here describe what an approved '
      + 'process goes on to do: the guard evaluates the command it is shown, so a process it '
      + 'allowed can write, spawn and transmit without a further decision, and an action refused '
      + 'when requested directly succeeds silently when a permitted process performs it. That '
      + 'boundary decides what "protected" means for this package; it is demonstrated in '
      + 'test/subprocess-boundary.contract.test.js.',
    totals: { files: byFile.size, sites: sites.length, byCapability, byRole },
    unguarded: entries.filter((e) => e.role === 'unguarded'),
    entries,
    unclassified,
  };
}

/**
 * Recorded classifications that no longer describe any call site the scan found.
 *
 * The companion failure to `unclassified`: a list stops describing the code
 * when a file drops its last risky call and keeps its justification. Both
 * invariants are checked against the same freshly built inventory, so the
 * script's verdict is the test's verdict rather than a second opinion about an
 * artifact it just regenerated.
 */
function staleClassifications(manifest) {
  const withSites = new Set(manifest.entries.map((entry) => entry.file));
  return Object.keys(CLASSIFIED).filter((file) => !withSites.has(file));
}

function main() {
  const manifest = buildCoverageManifest();
  fs.writeFileSync(path.join(repoRoot, 'coverage-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`enforcement coverage: ${manifest.totals.sites} call sites across ${manifest.totals.files} files`);
  for (const [capability, count] of Object.entries(manifest.totals.byCapability).sort()) {
    console.log(`  ${capability.padEnd(10)} ${count}`);
  }
  console.log('');
  console.log('by role:');
  for (const [role, count] of Object.entries(manifest.totals.byRole).sort()) {
    console.log(`  ${role.padEnd(14)} ${count}`);
  }
  if (manifest.unguarded.length > 0) {
    console.log('');
    console.log('outside the admission boundary:');
    for (const entry of manifest.unguarded) console.log(`  ${entry.file}`);
  }
  console.log('');
  console.log('written: coverage-manifest.json');

  const stale = staleClassifications(manifest);

  if (manifest.unclassified.length === 0 && stale.length === 0) {
    // Deliberately specific about what was verified. An "OK" printed after
    // regenerating the artifact and checking nothing is how a gate passes while
    // measuring the wrong thing.
    console.log(`OK: ${manifest.totals.sites} call site(s) across ${manifest.totals.files} file(s): `
      + 'every one has a recorded role, and every recorded classification still describes a file '
      + 'with such a site.');
    return 0;
  }

  if (manifest.unclassified.length > 0) {
    console.error('');
    console.error(`FAIL: ${manifest.unclassified.length} file(s) can act on the world with no recorded role:`);
    console.error('');
    for (const entry of manifest.unclassified) {
      console.error(`  ${entry.file}  (${entry.sites} site(s): ${entry.capabilities.join(', ')})`);
    }
    console.error('');
    console.error('Add each to CLASSIFIED in scripts/enforcement-coverage-classification.js with the');
    console.error('role it plays and why it holds that capability. "unguarded" is a valid answer and');
    console.error('is published as such; an unexamined one is not.');
  }

  if (stale.length > 0) {
    console.error('');
    console.error(`FAIL: ${stale.length} recorded classification(s) no longer describe any call site:`);
    console.error('');
    for (const file of stale) console.error(`  ${file}`);
    console.error('');
    console.error('Remove each from CLASSIFIED in scripts/enforcement-coverage-classification.js. A');
    console.error('classification is how a file\'s capability is justified; one that describes no call');
    console.error('site is how the list stops describing the code.');
  }

  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  collectSites,
  sitesIn,
  bindingsFor,
  resolveBindings,
  stripComments,
  stripCommentsAndStrings,
  buildCoverageManifest,
  staleClassifications,
  CAPABILITIES,
  productionFiles,
};
