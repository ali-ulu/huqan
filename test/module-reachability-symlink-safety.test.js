const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');
const { analyzeReachability } = require('../lib/module-reachability');
const { listMarkdownFiles } = require('../adapters/markdown-adapter');
const { listYamlFiles } = require('../adapters/yaml-adapter');
const { listJsonFiles } = require('../adapters/json-adapter');
const { listPdfFiles } = require('../adapters/pdf-adapter');

/**
 * collectSourceFiles is module-private, so it is loaded here the same way the
 * module itself is evaluated. Exporting it purely for a test would widen the
 * module's surface for no other caller.
 */
function loadCollectSourceFiles() {
  const modulePath = require.resolve('../lib/module-reachability');
  const source = fs.readFileSync(modulePath, 'utf8');
  const factory = new Function(
    'require', 'module', 'exports', '__dirname', '__filename',
    `${source}\nmodule.exports.__collectSourceFiles = collectSourceFiles;`,
  );
  const shim = { exports: {} };
  factory(createRequire(modulePath), shim, shim.exports, path.dirname(modulePath), modulePath);
  return shim.exports.__collectSourceFiles;
}

let tempDir;
let repoRoot;
let outsideDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-symlink-'));
  repoRoot = path.join(tempDir, 'repo');
  outsideDir = path.join(tempDir, 'outside');
  fs.mkdirSync(path.join(repoRoot, 'sub'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  fs.writeFileSync(path.join(repoRoot, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(repoRoot, 'sub', 'inner.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(outsideDir, 'leaked.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(outsideDir, 'notes.md'), '# outside\n');

  // A symlink whose name is inside the repository but whose target is not.
  fs.symlinkSync(outsideDir, path.join(repoRoot, 'external'), 'dir');
  // In-root cycles: parent and self.
  fs.symlinkSync('..', path.join(repoRoot, 'sub', 'loop'), 'dir');
  fs.symlinkSync('.', path.join(repoRoot, 'sub', 'self'), 'dir');
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('module-reachability walker is symlink-safe (#744)', () => {
  it('terminates on in-root symlink cycles', () => {
    const collect = loadCollectSourceFiles();
    // Before the fix this threw ELOOP rather than returning.
    let files;
    assert.doesNotThrow(() => { files = collect(repoRoot); }, 'the walk must terminate');
    assert.ok(Array.isArray(files));
  });

  it('does not follow a symlink out of the repository', () => {
    const collect = loadCollectSourceFiles();
    const files = collect(repoRoot);
    assert.deepStrictEqual(
      files.filter((file) => file.includes(`${path.sep}outside${path.sep}`)),
      [],
      'a file outside the repository reached the source inventory',
    );
    assert.ok(!files.some((file) => file.endsWith('leaked.js')));
  });

  it('finds exactly the real in-repository sources, each once', () => {
    const collect = loadCollectSourceFiles();
    const relative = collect(repoRoot)
      .map((file) => path.relative(fs.realpathSync(repoRoot), file).split(path.sep).join('/'))
      .sort();
    assert.deepStrictEqual(relative, ['index.js', 'sub/inner.js']);
  });

  it('a directory reachable under two names is walked once', () => {
    const aliased = path.join(tempDir, 'aliased');
    fs.mkdirSync(path.join(aliased, 'real'), { recursive: true });
    fs.writeFileSync(path.join(aliased, 'real', 'once.js'), 'module.exports = {};\n');
    fs.symlinkSync(path.join(aliased, 'real'), path.join(aliased, 'alias'), 'dir');

    const collect = loadCollectSourceFiles();
    const files = collect(aliased).filter((file) => file.endsWith('once.js'));
    assert.strictEqual(files.length, 1, `once.js was collected ${files.length} times`);
  });

  it('the real repository still analyzes cleanly', () => {
    // The classification semantics this module exists for must be unchanged.
    const result = analyzeReachability({ root: path.join(__dirname, '..') });
    assert.ok(Array.isArray(result.unacknowledged));
    assert.ok(Array.isArray(result.staleAcknowledgements));
  });
});

describe('ingest walkers are cycle-safe and root-bounded (#763)', () => {
  let cycleRoot;

  before(() => {
    // The cycle has to stay *inside* the walk root to exercise cycle handling
    // rather than the out-of-root rejection: `a/up -> ..` resolves to the root
    // itself, and `a/self -> .` back to `a`.
    cycleRoot = path.join(tempDir, 'cycle-root');
    fs.mkdirSync(path.join(cycleRoot, 'a'), { recursive: true });
    fs.writeFileSync(path.join(cycleRoot, 'a', 'doc.md'), '# doc\n');
    fs.writeFileSync(path.join(cycleRoot, 'a', 'data.json'), '{"k":1}\n');
    fs.writeFileSync(path.join(cycleRoot, 'a', 'conf.yaml'), 'k: 1\n');
    fs.symlinkSync('..', path.join(cycleRoot, 'a', 'up'), 'dir');
    fs.symlinkSync('.', path.join(cycleRoot, 'a', 'self'), 'dir');
  });

  const walkers = [
    ['markdown', listMarkdownFiles, 'doc.md'],
    ['json', listJsonFiles, 'data.json'],
    ['yaml', listYamlFiles, 'conf.yaml'],
  ];

  for (const [label, walk, expected] of walkers) {
    it(`${label} listing terminates on an in-root cycle and returns each file once`, () => {
      let files;
      assert.doesNotThrow(() => { files = walk(cycleRoot, { rootPath: cycleRoot }); });
      const matches = files.filter((file) => file.endsWith(expected));
      assert.strictEqual(matches.length, 1, `${label}: expected one ${expected}, got ${matches.length}`);
    });
  }

  it('pdf listing terminates too', () => {
    assert.doesNotThrow(() => listPdfFiles(cycleRoot, { rootPath: cycleRoot }));
  });

  it('a symlink target outside the root is still rejected', () => {
    // repoRoot contains `external -> outside`, so a walk rooted there must
    // refuse rather than silently enumerate the external tree.
    assert.throws(
      () => listMarkdownFiles(repoRoot, { rootPath: repoRoot }),
      (error) => error.code === 'PATH_OUTSIDE_ALLOWED_ROOT',
    );
  });
});
