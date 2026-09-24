const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after } = require('node:test');
const test = require('node:test');
const { runVerify } = require('../lib/kernel-v2-verify');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-v2-verify.js'), 'utf8').replace(/\r\n/g, '\n');

test('KernelV2.verify is a one-line, cycle-free delegation (#2138)', () => {
  const deps = '\\{ v2: this, kernel: this\\.kernel, verifyBase: \\(\\.\\.\\.args\\) => this\\.kernel\\.verify\\(\\.\\.\\.args\\), ok: \\(\\.\\.\\.args\\) => this\\.ok\\(\\.\\.\\.args\\), withVerifyDetails: \\(\\.\\.\\.args\\) => this\\._withVerifyDetails\\(\\.\\.\\.args\\), buildContradictionDetails: \\(\\.\\.\\.args\\) => this\\._buildContradictionDetails\\(\\.\\.\\.args\\) \\}';
  assert.match(
    kernelSource,
    new RegExp(
      'verify\\(statement, opts = \\{\\}\\) \\{\\n'
      + `    return runVerify\\(${deps}, statement, opts\\);\n  \\}`,
    ),
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel\.v2/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /(v2|kernel)\._[A-Za-z]/, 'both passthroughs are opaque');
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-v2-verify')), ['runVerify']);
});

let tempDir;
let counter = 0;
before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v2-verify-'));
});
after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeV2(name) {
  const kernel = new Kernel({
    memoryPath: path.join(tempDir, `${name}-${counter++}.json`),
    useSQLite: false,
    noLoad: true,
    loadPlugins: false,
  });
  kernel._autoMaintain = () => {};
  return { kernel, v2: new KernelV2({ kernel }) };
}

function edge(graph, from, to, relation, workspaceId, weight = 0.9) {
  graph.addNode(from, from, null, { workspaceId });
  graph.addNode(to, to, null, { workspaceId });
  graph.addEdge(from, to, relation, { workspaceId, weight, confidence: weight });
}

test('verify resolves a supported claim through the moved orchestration', () => {
  const { v2 } = makeV2('supported');
  edge(v2.kernel.graph, 'kedi', 'kus', 'tür', 'default');
  edge(v2.kernel.graph, 'kus', 'ucar', 'tür', 'default');

  const result = v2.verify('kedi ucar', { workspaceId: 'default' });

  assert.equal(result.data.status, 'verified');
});

test('verify contradicts an opposite-predicate claim through the moved orchestration', () => {
  const { v2 } = makeV2('opposite');
  edge(v2.kernel.graph, 'kedi', 'ucmaz', 'yapar', 'default');

  const result = v2.verify('kedi ucar', { workspaceId: 'default' });

  assert.equal(result.data.status, 'contradicted');
  assert.equal(result.data.confidenceSource, 'opposite-predicate-map');
});

test('verify stays unknown with no evidence', () => {
  const { v2 } = makeV2('empty');

  const result = v2.verify('mars peynirdendir', { workspaceId: 'default' });

  assert.equal(result.data.status, 'unknown');
});
