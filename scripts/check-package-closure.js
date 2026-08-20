#!/usr/bin/env node
'use strict';

/**
 * Fail if a module the installed package loads is not in package.json#files.
 *
 * `files` is a hand-maintained allowlist, so it drifts the moment someone adds
 * a module and wires it into an already-published one. Nothing in the repo
 * notices: every path resolves from a clone, `npm test` passes, and the break
 * only appears after `npm install`, as a `Cannot find module` from inside
 * node_modules. Three such breaks shipped into v0.10.0's tarball at once --
 * all four file adapters (lib/safe-file-walk.js) and two plugins.
 *
 * What this checks, precisely: walk *load-time* requires -- those executed when
 * a module is required -- outward from the entry points an installed consumer
 * actually loads, and require every module reached that way to be published.
 *
 * Load-time is the whole distinction. This repository deliberately publishes
 * modules whose own dependencies are repo-only, and guards them at the call
 * site: server.js requires lib/http/v5-package-import-route.js inside a
 * try/catch so the route goes permanently unavailable rather than the server
 * failing to boot, and lib/a2a/exchange-route.js does the same for
 * lib/a2a/bounded-exchange.js. Those are decisions, and a checker that flagged
 * them would be reporting the design as a defect. A require that runs at load
 * time has no such guard: it either resolves or the module does not load.
 *
 * Scope note: like scripts/check-import-cycles.js this is a *static* read of
 * literal `require('./x')` calls, and it treats a require as load-time when it
 * sits at brace depth zero. A require inside `if`/`try`/a function body is
 * deferred and therefore out of scope, which is exactly the guarded case above.
 *
 * Usage:  node scripts/check-package-closure.js
 * Exit 0 = the load-time closure is fully published, exit 1 = something is not.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * Expand package.json#files into the concrete file set it ships. Entries may
 * name a directory (the manifest lists `lib/error-prevention`), so a bare
 * membership test against the array would miss everything inside one.
 *
 * @param {string} root repository root
 * @returns {Set<string>} repo-relative POSIX paths
 */
function publishedFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = new Set();
  const walkDir = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walkDir(full);
      else out.add(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  for (const entry of pkg.files || []) {
    const full = path.join(root, entry);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walkDir(full);
    else out.add(entry);
  }
  return out;
}

/**
 * Relative require specifiers that run when the module is loaded.
 *
 * Brace depth is the test: depth zero is module scope, anything deeper is
 * inside a function, a block or a try, and so is deferred. The scanner steps
 * over comments and string literals so a require mentioned in prose or inside
 * a template does not count.
 *
 * @param {string} src module source
 * @returns {string[]} specifiers, in source order
 */
function loadTimeRequires(src) {
  const found = [];
  let depth = 0;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0 && src.startsWith('require(', i)) {
      const match = /^require\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(src.slice(i));
      if (match) found.push(match[1]);
    }
    i += 1;
  }

  return found;
}

/**
 * Resolve a relative specifier the way CommonJS would, restricted to the file
 * forms this repository uses.
 *
 * @param {string} fromFile absolute path of the requiring module
 * @param {string} spec relative specifier
 * @returns {string|null} absolute path, or null when nothing resolves
 */
function resolveLocal(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The entry points an installed consumer loads.
 *
 * `main` and every `bin` are read from the manifest rather than restated, so a
 * newly declared executable is covered the moment it ships. Published plugins
 * and adapters are entries too: plugin.js loads the plugin directory with
 * readdirSync, which no static walk from `main` can see.
 *
 * @param {string} root repository root
 * @param {Set<string>} published expanded file set
 * @returns {string[]} repo-relative entry paths
 */
function loadTimeEntryPoints(root, published) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entries = new Set();
  if (pkg.main) entries.add(pkg.main.replace(/^\.\//, ''));
  for (const target of Object.values(pkg.bin || {})) entries.add(target.replace(/^\.\//, ''));
  for (const file of published) {
    if (!file.endsWith('.js')) continue;
    if (file.startsWith('plugins/') || file.startsWith('adapters/')) entries.add(file);
  }
  return [...entries].sort();
}

/**
 * @param {object} [opts]
 * @param {string} [opts.root] repository root
 * @returns {{entryPoints: string[], reached: string[], missing: Map<string, string[]>}}
 */
function analyzePackageClosure(opts = {}) {
  const root = opts && opts.root ? opts.root : repoRoot;
  const published = publishedFiles(root);
  const entryPoints = loadTimeEntryPoints(root, published);
  const reached = new Set();
  const missing = new Map();

  const walk = (rel) => {
    if (reached.has(rel)) return;
    reached.add(rel);
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !rel.endsWith('.js')) return;

    for (const spec of loadTimeRequires(fs.readFileSync(full, 'utf8'))) {
      const resolved = resolveLocal(full, spec);
      // Unresolvable specifiers are left to Node: a typo'd path fails the same
      // way in a clone as in an install, so it is not a packaging finding.
      if (!resolved) continue;
      const target = path.relative(root, resolved).split(path.sep).join('/');
      if (published.has(target)) walk(target);
      else if (missing.has(target)) missing.get(target).push(rel);
      else missing.set(target, [rel]);
    }
  };

  for (const entry of entryPoints) {
    if (fs.existsSync(path.join(root, entry))) walk(entry);
  }

  for (const [, requiredBy] of missing) requiredBy.sort();
  return { entryPoints, reached: [...reached].sort(), missing };
}

function main() {
  const { entryPoints, reached, missing } = analyzePackageClosure();

  if (missing.size === 0) {
    console.log(
      `OK: the load-time closure of ${reached.length} modules `
      + `from ${entryPoints.length} published entry points is fully published.`,
    );
    return 0;
  }

  console.error(`FAIL: ${missing.size} module(s) load at install time but are not published.\n`);
  for (const target of [...missing.keys()].sort()) {
    console.error(`  ${target}`);
    console.error(`      required at load time by: ${missing.get(target).join(', ')}`);
  }
  console.error(
    '\nAn installed consumer gets "Cannot find module" for each of these.',
    '\nAdd them to package.json#files, or -- if the dependency is meant to stay',
    '\nrepo-only -- move the require inside a guard at the call site, the way',
    '\nserver.js does for lib/http/v5-package-import-route.js.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  analyzePackageClosure,
  loadTimeRequires,
  loadTimeEntryPoints,
  publishedFiles,
};
