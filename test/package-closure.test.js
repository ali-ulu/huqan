'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  analyzePackageClosure,
  analyzePackageClosures,
  loadTimeRequires,
  loadTimeEntryPoints,
  publishedFiles,
  packageRoots,
} = require('../scripts/check-package-closure');
const {
  RETAINED_DEEP_IMPORTS,
  retainedDeepImportFiles,
  retainedDeepImportSpecifiers,
} = require('../scripts/retained-deep-imports');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── the invariant ───────────────────────────────────────────────────────────

test('every module the installed package loads is published', () => {
  const { missing } = analyzePackageClosure({ root: REPO_ROOT });
  const report = [...missing.keys()].sort()
    .map((file) => `  ${file}  (required by ${missing.get(file).join(', ')})`)
    .join('\n');
  assert.deepEqual([...missing.keys()], [],
    'these modules run at install time but are not in package.json#files, so an '
    + 'installed consumer gets "Cannot find module" for each:\n' + report);
});

test('every publishable package is included in closure analysis (#1071)', () => {
  const roots = packageRoots(REPO_ROOT);
  assert.equal(roots.includes(path.join(REPO_ROOT, 'packages', 'huqan-verify')), false,
    'the broken legacy package must stay explicitly private');
  assert.equal(roots.includes(path.join(REPO_ROOT, 'packages', 'axiom-verify')), false,
    'the compatibility alias must stay explicitly private');
  assert.equal(analyzePackageClosures({ root: REPO_ROOT }).every(report => report.missing.size === 0), true);
});

test('a publishable nested package with an escaped require fails closure (#1071)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-package-closure-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', main: 'index.js', files: ['index.js'] }));
    fs.writeFileSync(path.join(root, 'index.js'), "module.exports = {};\n");
    fs.writeFileSync(path.join(root, 'missing.js'), "module.exports = {};\n");
    fs.mkdirSync(path.join(root, 'packages', 'publishable'), { recursive: true });
    const nested = path.join(root, 'packages', 'publishable');
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'publishable', main: 'index.js', files: ['index.js'] }));
    fs.writeFileSync(path.join(nested, 'index.js'), "module.exports = require('../../missing');\n");
    const reports = analyzePackageClosures({ root });
    const nestedReport = reports.find(report => report.root === nested);
    assert.ok(nestedReport);
    assert.equal(nestedReport.missing.size, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── the analysis itself ─────────────────────────────────────────────────────
//
// package.json#files is an allowlist nobody reads top to bottom, so the check
// above is only worth what its walk is worth. These pin the walk's shape: a
// version that silently reached nothing would still report an empty `missing`.

test('the walk starts from the manifest, not from a restated list', () => {
  const published = publishedFiles(REPO_ROOT);
  const entries = loadTimeEntryPoints(REPO_ROOT, published);
  // main and every declared bin, read from package.json.
  assert.ok(entries.includes('index.js'));
  assert.ok(entries.includes('cli.js'));
  assert.ok(entries.includes('bin/huqan-mcp.js'));
  // plugin.js loads the plugin directory with readdirSync, so no static walk
  // from main can see these; they are entry points in their own right.
  assert.ok(entries.includes('plugins/company-brain.js'));
  assert.ok(entries.includes('adapters/markdown-adapter.js'));
});

test('every retained deep import is an entry point of the walk', () => {
  // The gap this closes. `server.js` is a supported import that nothing under
  // `index.js` requires, so its subtree was never walked and
  // lib/http/external-action-receipt-collector-route.js shipped unpublished
  // while this gate reported a complete closure. Reaching a module from `main`
  // is not the same as a consumer being able to load it.
  const published = publishedFiles(REPO_ROOT);
  const entries = new Set(loadTimeEntryPoints(REPO_ROOT, published));
  for (const file of retainedDeepImportFiles()) {
    assert.ok(entries.has(file), `${file} is a retained deep import but not an entry point`);
    assert.ok(published.has(file), `${file} is a retained deep import but is not published`);
  }
});

test('the two gates over the deep-import surface read one list', () => {
  // The smoke test in kernel-facade-contract requires each specifier out of a
  // real installation; this walk covers each file. They disagreed once, which
  // is why the declaration is shared rather than restated in both places.
  for (const entry of RETAINED_DEEP_IMPORTS) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.file)), `${entry.file} does not exist`);
    assert.ok(entry.specifier === 'huqan' || entry.specifier.startsWith('huqan/'),
      `${entry.specifier} is not a specifier for this package`);
  }
  const specifiers = retainedDeepImportSpecifiers();
  assert.ok(specifiers.includes('huqan/server'), 'huqan/server must stay covered');
  assert.ok(specifiers.includes('huqan/server.js'), 'both spellings resolve, so both are tested');
  assert.equal(new Set(specifiers).size, specifiers.length, 'no duplicate specifiers');
});

test('the closure is substantial, so an empty result would not read as a pass', () => {
  const { reached } = analyzePackageClosure({ root: REPO_ROOT });
  assert.ok(reached.length > 150, `only ${reached.length} modules reached`);
  for (const file of ['graph.js', 'lib/verify.js', 'lib/memory-store.js', 'lib/safe-file-walk.js']) {
    assert.ok(reached.includes(file), `${file} should be in the load-time closure`);
  }
});

test('a directory entry in files expands to the files inside it', () => {
  // The manifest lists `lib/error-prevention` bare, so a membership test
  // against the array alone would treat everything inside it as unpublished.
  const published = publishedFiles(REPO_ROOT);
  const inside = [...published].filter((f) => f.startsWith('lib/error-prevention/'));
  assert.ok(inside.length > 0, 'directory entries must expand');
});

// ─── load-time vs deferred ───────────────────────────────────────────────────
//
// The distinction the whole check rests on. This repository publishes modules
// whose own dependencies are repo-only and guards them at the call site; a
// scanner that could not tell the two apart would report that design as a bug.

test('a require at module scope counts, one inside a guard does not', () => {
  assert.deepEqual(loadTimeRequires("const x = require('./a');"), ['./a']);
  assert.deepEqual(loadTimeRequires("function f() { return require('./a'); }"), []);
  assert.deepEqual(loadTimeRequires("const f = function () { require('./a'); };"), []);
  assert.deepEqual(loadTimeRequires("const f = () => { require('./a'); };"), []);
  assert.deepEqual(loadTimeRequires("module.exports = { run() { require('./a'); } };"), []);
  assert.deepEqual(loadTimeRequires("class C { m() { require('./a'); } }"), []);
  assert.deepEqual(loadTimeRequires("try { require('./a'); } catch (_) {}"), []);
  assert.deepEqual(loadTimeRequires("try { x(); } catch (e) { require('./a'); }"), []);
});

test('a brace that only groups defers nothing', () => {
  // #979: the scanner used to call any `{` a boundary, so these three read as
  // deferred and their modules could be left out of the tarball while the
  // check still passed -- the exact failure class the check exists to catch,
  // since every one of them runs while the module is being evaluated.
  assert.deepEqual(loadTimeRequires("const registry = { x: require('./a') };"), ['./a']);
  assert.deepEqual(loadTimeRequires("if (flag) { require('./a'); }"), ['./a']);
  assert.deepEqual(loadTimeRequires("for (const x of xs) { require('./a'); }"), ['./a']);
  // and a grouping brace must not swallow what follows it either
  assert.deepEqual(loadTimeRequires("const o = { a: 1 };\nrequire('./a');"), ['./a']);
});

test('requires named in comments and strings do not count', () => {
  assert.deepEqual(loadTimeRequires("// see require('./a')\n"), []);
  assert.deepEqual(loadTimeRequires("/* require('./a') */"), []);
  assert.deepEqual(loadTimeRequires("const s = \"require('./a')\";"), []);
  assert.deepEqual(loadTimeRequires('const s = `require(\'./a\')`;'), []);
});

test('bare package specifiers are out of scope', () => {
  // Third-party resolution is package.json#dependencies' problem, not the
  // files allowlist's.
  assert.deepEqual(loadTimeRequires("const fs = require('node:fs');"), []);
  assert.deepEqual(loadTimeRequires("const yaml = require('js-yaml');"), []);
});

test('the guarded repo-only families stay out of the closure', () => {
  // server.js requires the V5 import route inside a try/catch, so the installed
  // package boots without it and the route goes unavailable. lib/v5/ ships in
  // no tarball at all -- 8 files on disk, 0 in `files` -- so a load-time
  // require of any of them would break every install. If one appears here, the
  // check above would then demand the whole V5 family be published.
  const published = publishedFiles(REPO_ROOT);
  const { reached } = analyzePackageClosure({ root: REPO_ROOT });
  for (const file of reached) {
    assert.ok(!file.startsWith('lib/v5/'), `${file} must not load at install time`);
  }
  const v5 = [...published].filter(file => file.startsWith('lib/v5/'));
  assert.deepEqual(v5, [], 'lib/v5 is repo-only; publishing it would change what this guards');
});

test('a deferred module that later loads eagerly is only a finding if it is unpublished', () => {
  // This assertion used to name lib/a2a/bounded-exchange.js beside lib/v5/,
  // as though both were repo-only. They are not: bounded-exchange is published.
  // When lib/registry/registry-route.js (#1813) began requiring it at load time
  // the old shape read that as a regression, when the only thing that had
  // changed was *when* a shipped module loads. What actually matters is that
  // whatever loads eagerly is in the tarball, and the closure check above is
  // what enforces that -- so the distinction is published vs not, not deferred
  // vs not.
  const published = publishedFiles(REPO_ROOT);
  const { reached, missing } = analyzePackageClosure({ root: REPO_ROOT });
  assert.ok(reached.includes('lib/a2a/bounded-exchange.js'),
    'the registry route requires it at load time; if that stops being true, drop this test');
  assert.ok(published.has('lib/a2a/bounded-exchange.js'),
    'a load-time module must ship, or an installed consumer cannot boot the server');
  assert.equal(missing.size, 0);
});

// ─── what `files` does and does not have to say (#1471) ──────────────────────

test('npm-always-published root files are treated as published without a files entry', () => {
  // mcpServer.js requires ./package.json at load time. Modelling `files` as the
  // whole published set made this gate demand a redundant "package.json" entry
  // and report "Cannot find module" for a file npm puts in every tarball.
  const published = publishedFiles(REPO_ROOT);
  const listed = new Set(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).files);

  for (const name of ['package.json', 'README.md', 'LICENSE']) {
    assert.ok(published.has(name), `${name} must count as published`);
    assert.ok(!listed.has(name), `${name} is always published, so listing it in files is redundant`);
  }
});

test('nested package readmes stay listed explicitly, because npm only auto-publishes the root one', () => {
  // A bare "README.md" entry in `files` behaves like a gitignore pattern and
  // matches at any depth, so it was silently carrying the sub-package readmes.
  // Removing it as "redundant" dropped both from the tarball; npm's automatic
  // inclusion covers only the root readme. Measured with `npm pack --dry-run`.
  const listed = new Set(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).files);

  for (const pkg of ['axiom-verify', 'huqan-verify']) {
    const readme = `packages/${pkg}/README.md`;
    assert.ok(fs.existsSync(path.join(REPO_ROOT, readme)), `${readme} must exist`);
    assert.ok(listed.has(readme), `${readme} must be listed explicitly, like its package.json sibling`);
  }
});
