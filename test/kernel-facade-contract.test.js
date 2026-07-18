const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PackageKernel = require('..');
const Kernel = require('../kernel');

const FACADE_METHODS = Object.freeze([
  'learn',
  'ask',
  'verify',
  'reason',
  'compare',
  'dream',
  'detectGaps',
  'detectContradictions',
  'getPersistenceDescriptor',
  'reload',
  'persist',
  'optimize',
  'entropy',
  'consolidate',
  'selfEvolve',
  'startAutoThink',
  'stopAutoThink',
  'usePlugin',
]);

function makeKernel() {
  const root = path.join(os.tmpdir(), `huqan-kernel-facade-${process.pid}-${Date.now()}`);
  return new PackageKernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

test('package entry resolves to the canonical Kernel constructor', () => {
  assert.equal(PackageKernel, Kernel);
  assert.equal(typeof PackageKernel, 'function');
  assert.equal(PackageKernel.name, 'Kernel');
});

test('Kernel exposes the documented static contract markers', () => {
  assert.equal(typeof PackageKernel.CONTRACT_VERSION, 'string');
  assert.match(PackageKernel.CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof PackageKernel.AXIOM_ERROR, 'object');
  assert.equal(PackageKernel.AXIOM_ERROR.INVALID_INPUT, 'INVALID_INPUT');
});

test('Kernel instances expose the frozen high-level facade methods', () => {
  const kernel = makeKernel();

  try {
    assert.equal(kernel.contractVersion, PackageKernel.CONTRACT_VERSION);
    for (const method of FACADE_METHODS) {
      assert.equal(typeof kernel[method], 'function', `${method} must remain callable`);
    }
  } finally {
    kernel.graph.close();
  }
});

test('graph and memory remain observable compatibility surfaces', () => {
  const kernel = makeKernel();

  try {
    assert.equal(typeof kernel.graph, 'object');
    assert.equal(typeof kernel.graph.load, 'function');
    assert.equal(typeof kernel.graph.save, 'function');
    assert.equal(typeof kernel.memory, 'object');
    assert.equal(typeof kernel.memory.close, 'function');
  } finally {
    kernel.graph.close();
  }
});

test('kernel.d.ts remains aligned with observable graph and memory surfaces', () => {
  const declaration = fs.readFileSync(path.join(__dirname, '..', 'kernel.d.ts'), 'utf8');
  const classStart = declaration.indexOf('declare class Kernel');

  assert.notEqual(classStart, -1, 'Kernel declaration must remain present');

  const kernelDeclaration = declaration.slice(classStart);
  assert.match(
    kernelDeclaration,
    /\bgraph\s*:\s*\{[\s\S]*?\bload\(\)\s*:\s*void\s*;[\s\S]*?\bsave\(\)\s*:\s*void\s*;[\s\S]*?\}\s*;/,
  );
  assert.match(
    kernelDeclaration,
    /\bmemory\s*:\s*\{[\s\S]*?\bclose\(\)\s*:\s*void\s*;[\s\S]*?\}\s*;/,
  );
  assert.match(
    kernelDeclaration,
    /\bgetPersistenceDescriptor\(\)\s*:\s*Readonly<\{\s*memoryPath\s*:\s*string\s*;\s*dbPath\s*:\s*string\s*;\s*\}>\s*;/,
  );
  assert.match(
    kernelDeclaration,
    /\breload\(\)\s*:\s*void\s*;/,
  );
  assert.match(
    kernelDeclaration,
    /\bpersist\(\)\s*:\s*void\s*;/,
  );
  assert.match(
    kernelDeclaration,
    /\boptimize\(\)\s*:\s*\{\s*pruned\s*:\s*number\s*;\s*removedNodes\s*:\s*number\s*;\s*\}\s*;/,
  );

  const seamDeclarations = kernelDeclaration.slice(
    kernelDeclaration.indexOf('getPersistenceDescriptor'),
    kernelDeclaration.indexOf('paranoidMode'),
  );
  assert.doesNotMatch(
    seamDeclarations,
    /\bPromise\b|\bany\b|\bRecord\s*</,
  );
  assert.doesNotMatch(seamDeclarations, /\w+\?\s*\(/);
});
