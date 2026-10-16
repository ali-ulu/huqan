const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after } = require('node:test');
const test = require('node:test');
const { runContradictionDetails, findOppositePredicateConflict } = require('../lib/kernel-v2-contradiction');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-v2-contradiction.js'), 'utf8').replace(/\r\n/g, '\n');

test('KernelV2 contradiction methods are one-line, cycle-free delegations (#2138)', () => {
  const deps = '\\{ v2: this, graph: this\\.kernel\\.graph, collectPredicateTargets: \\(\\.\\.\\.args\\) => this\\._collectPredicateTargets\\(\\.\\.\\.args\\), collectTypeTargets: \\(\\.\\.\\.args\\) => this\\._collectTypeTargets\\(\\.\\.\\.args\\), inferTypeChain: \\(\\.\\.\\.args\\) => this\\._inferTypeChain\\(\\.\\.\\.args\\), buildPredicateEvidence: \\(\\.\\.\\.args\\) => this\\._buildPredicateEvidence\\(\\.\\.\\.args\\), directTypeEvidence: \\(\\.\\.\\.args\\) => this\\.buildDirectTypeEvidence\\(\\.\\.\\.args\\) \\}';
  assert.match(
    kernelSource,
    new RegExp(
      '_findOppositePredicateConflict\\(subject, normalizedTargetToken, maxDepth = 4, workspaceId = \'default\'\\) \\{\\n'
      + `    return findOppositePredicateConflict\\(${deps}, subject, normalizedTargetToken, maxDepth, workspaceId\\);\n  \\}\n`,
    ),
  );
  assert.match(
    kernelSource,
    new RegExp(
      '_buildContradictionDetails\\(parsed, normalizedTarget, normalizedTargetToken, opts = \\{\\}\\) \\{\\n'
      + `    return runContradictionDetails\\(${deps}, parsed, normalizedTarget, normalizedTargetToken, opts\\);\n  \\}`,
    ),
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel\.v2/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /v2\._[A-Za-z]/, 'the v2 passthrough is opaque: only buildNegationConflict receives it');
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(
    Object.keys(require('../lib/kernel-v2-contradiction')).sort(),
    ['findOppositePredicateConflict', 'runContradictionDetails'],
  );
});

let tempDir;
let counter = 0;
before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v2-contradiction-'));
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

test('direct opposite predicate hit contradicts via the map', () => {
  const { v2 } = makeV2('opposite');
  edge(v2.kernel.graph, 'kedi', 'ucmaz', 'yapar', 'default');

  const details = v2._buildContradictionDetails(
    { subject: 'kedi', predicate: 'ucar', isNegated: false },
    'ucar',
    'ucar',
    { workspaceId: 'default' },
  );

  assert.equal(details.status, 'contradicted');
  assert.equal(details.contradictionReason, 'opposite_predicate_conflict');
  assert.equal(details.confidenceSource, 'opposite-predicate-map');
});

test('type chain verifies a supported claim', () => {
  const { v2 } = makeV2('chain');
  edge(v2.kernel.graph, 'kedi', 'kus', 'tür', 'default');
  edge(v2.kernel.graph, 'kus', 'ucar', 'tür', 'default');

  const details = v2._buildContradictionDetails(
    { subject: 'kedi', predicate: 'ucar', isNegated: false },
    'ucar',
    'ucar',
    { workspaceId: 'default' },
  );

  assert.equal(details.status, 'verified');
  assert.equal(details.confidenceSource, 'path-average');
});

test('no evidence returns null', () => {
  const { v2 } = makeV2('empty');
  v2.kernel.graph.addNode('yalniz', 'yalniz', null, { workspaceId: 'default' });

  const details = v2._buildContradictionDetails(
    { subject: 'yalniz', predicate: 'bitki', isNegated: false },
    'bitki',
    'bitki',
    { workspaceId: 'default' },
  );

  assert.equal(details, null);
});
