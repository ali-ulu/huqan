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
 * literal `require('./x')` calls. What defers one is a *function body* or a
 * `try`/`catch` block -- the two forms that decide at run time whether the
 * require ever executes. A brace that only groups (an object literal, an
 * `if`/`for`/`while` block at module scope) defers nothing: the require inside
 * it still runs while the module is being evaluated, so the module it names
 * has to be in the tarball.
 *
 * Usage:  node scripts/check-package-closure.js
 * Exit 0 = the load-time closure is fully published, exit 1 = something is not.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function packageRoots(root) {
  const roots = [root];
  const packagesDir = path.join(root, 'packages');
  if (!fs.existsSync(packagesDir)) return roots;
  for (const name of fs.readdirSync(packagesDir).sort()) {
    const candidate = path.join(packagesDir, name);
    const manifest = path.join(candidate, 'package.json');
    if (!fs.statSync(candidate).isDirectory() || !fs.existsSync(manifest)) continue;
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).private !== true) roots.push(candidate);
  }
  return roots;
}

/**
 * Expand package.json#files into the concrete file set it ships. Entries may
 * name a directory (the manifest lists `lib/error-prevention`), so a bare
 * membership test against the array would miss everything inside one.
 *
 * @param {string} root repository root
 * @returns {Set<string>} repo-relative POSIX paths
 */
/**
 * Files npm publishes whether or not `files` lists them.
 *
 * npm always ships the manifest, the readme and the licence from the package
 * root. Modelling `files` as the whole published set therefore reports a false
 * failure for them: mcpServer.js requires `./package.json` at load time, so
 * dropping the redundant `"package.json"` entry made this gate claim an
 * installed consumer would get "Cannot find module" -- for a file npm puts in
 * every tarball. Verified with `npm pack --dry-run`: removing the entry leaves
 * package.json in the tarball, and `npm run verify:tarball` installs and runs
 * it. Only the root files are covered; a nested readme is published only if an
 * entry matches it, which is why packages/*'/'README.md are listed explicitly.
 */
const ALWAYS_PUBLISHED = Object.freeze(['package.json', 'README.md', 'LICENSE']);

function publishedFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = new Set(ALWAYS_PUBLISHED.filter((name) => fs.existsSync(path.join(root, name))));
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

/** Keywords whose parenthesised head introduces a block, not a function body. */
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch']);

/**
 * Does the `{` just opened defer what is inside it?
 *
 * Only two forms do. A function body runs when something calls it, and a
 * `try`/`catch` block is the repository's deliberate guard for a repo-only
 * dependency -- both mean the require may never execute. Everything else --
 * an object literal, an `if` or `for` block, a bare block -- is evaluated as
 * the module loads, so a require inside it is a load-time require.
 *
 * The decision is made from the token immediately before the brace, and where
 * that token is `)`, from the one before its matching `(`:
 *
 *   `=> {`                     function body        deferred
 *   `try {`                    guard                deferred
 *   `catch (e) {`              guard                deferred
 *   `function f() {` / `f() {` function body        deferred
 *   `if (x) {` / `for (…) {`   block                load-time
 *   `= {` / `, {` / `: {`      object literal       load-time
 *
 * Anything unrecognized is treated as load-time. That is the safe direction
 * for a packaging guard: it can ask for a module to be published that did not
 * strictly need to be, but it cannot wave one through that an installed
 * consumer will fail to resolve.
 *
 * @param {string[]} tokens significant tokens seen so far, in source order
 * @returns {boolean} true when the brace defers its contents
 */
function braceDefers(tokens) {
  const prev = tokens[tokens.length - 1];
  if (prev === undefined) return false;
  if (prev === '=>' || prev === 'try') return true;
  if (prev !== ')') return false;

  // Walk back to the `(` this `)` closes, then read the token in front of it.
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i] === ')') depth += 1;
    else if (tokens[i] === '(') {
      depth -= 1;
      if (depth === 0) {
        const head = tokens[i - 1];
        if (head === 'catch') return true;
        return !BLOCK_HEADS.has(head);
      }
    }
  }
  return false;
}

/**
 * Relative require specifiers that run when the module is loaded.
 *
 * The scanner steps over comments and string literals so a require mentioned
 * in prose or inside a template does not count, and keeps a stack of the
 * braces it is inside. A require counts when no brace enclosing it defers --
 * see braceDefers for which ones do.
 *
 * @param {string} src module source
 * @returns {string[]} specifiers, in source order
 */
function loadTimeRequires(src) {
  const found = [];
  const deferring = [];
  const tokens = [];
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
      tokens.push('<string>');
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let word = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
        word += src[i];
        i += 1;
      }
      if (word === 'require' && deferring.every((d) => !d)) {
        const match = /^require\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(src.slice(i - word.length));
        if (match) found.push(match[1]);
      }
      tokens.push(word);
      continue;
    }

    if (c === '{') deferring.push(braceDefers(tokens));
    else if (c === '}') deferring.pop();

    if (!/\s/.test(c)) tokens.push(c === '=' && src[i + 1] === '>' ? '=>' : c);
    if (c === '=' && src[i + 1] === '>') i += 1;
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

function analyzePackageClosures(opts = {}) {
  const root = opts && opts.root ? opts.root : repoRoot;
  return packageRoots(root).map(packageRoot => ({
    root: packageRoot,
    ...analyzePackageClosure({ root: packageRoot }),
  }));
}

function main() {
  const reports = analyzePackageClosures();
  const failures = reports.filter(report => report.missing.size > 0);

  if (failures.length === 0) {
    const reached = reports.reduce((total, report) => total + report.reached.length, 0);
    const entryPoints = reports.reduce((total, report) => total + report.entryPoints.length, 0);
    console.log(
      `OK: the load-time closure of ${reached} modules `
      + `from ${entryPoints} published entry points is fully published.`,
    );
    return 0;
  }

  const missingCount = failures.reduce((total, report) => total + report.missing.size, 0);
  console.error(`FAIL: ${missingCount} module(s) load at install time but are not published.\n`);
  for (const report of failures) {
    for (const target of [...report.missing.keys()].sort()) {
      console.error(`  ${path.relative(repoRoot, report.root) || '.'}/${target}`);
      console.error(`      required at load time by: ${report.missing.get(target).join(', ')}`);
    }
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
  analyzePackageClosures,
  loadTimeRequires,
  loadTimeEntryPoints,
  packageRoots,
  publishedFiles,
};
