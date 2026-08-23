const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const {
  detectTypeLatticeConflict,
  collectTypeAncestors,
  registerDisjointPair,
} = require('../lib/type-lattice');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-type-lattice-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });
}

describe('type-lattice', () => {
  it('collects transitive type ancestors deterministically', () => {
    const kernel = makeKernel('closure');
    kernel.graph.addNode('köpek', 'köpek', null, { workspaceId: 'default' });
    kernel.graph.addNode('hayvan', 'hayvan', null, { workspaceId: 'default' });
    kernel.graph.addNode('canlı', 'canlı', null, { workspaceId: 'default' });
    kernel.graph.addNode('organizma', 'organizma', null, { workspaceId: 'default' });
    kernel.graph.addEdge('köpek', 'hayvan', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('hayvan', 'canlı', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('canlı', 'organizma', 'tür', { workspaceId: 'default' });

    const ancestors = collectTypeAncestors(kernel.graph, 'köpek', 'default');
    const types = ancestors.map(entry => entry.type);

    // `canli`, not `canlı`: node ids are ASCII-folded, and dotless ı now folds
    // with the other five Turkish letters instead of being the one exception
    // that made a word's token depend on its case (#1196).
    assert.deepStrictEqual(types.slice(0, 3), ['hayvan', 'canli', 'organizma']);
  });

  it('detects disjoint type conflicts through the lattice', () => {
    const kernel = makeKernel('conflict');
    kernel.graph.addNode('köpek', 'köpek', null, { workspaceId: 'default' });
    kernel.graph.addNode('hayvan', 'hayvan', null, { workspaceId: 'default' });
    kernel.graph.addNode('canlı', 'canlı', null, { workspaceId: 'default' });
    kernel.graph.addNode('organizma', 'organizma', null, { workspaceId: 'default' });
    kernel.graph.addEdge('köpek', 'hayvan', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('hayvan', 'canlı', 'tür', { workspaceId: 'default' });
    kernel.graph.addEdge('canlı', 'organizma', 'tür', { workspaceId: 'default' });

    const signal = detectTypeLatticeConflict(kernel.graph, 'köpek', 'bitki', 'default');

    assert.ok(signal);
    assert.strictEqual(signal.rule, 'TYPE_CONFLICT');
    assert.ok(signal.flags.includes('TYPE_LATTICE_CONFLICT'));
    assert.ok(signal.meta.ancestors.includes('hayvan'));
  });

  it('does not flag compatible type claims', () => {
    const kernel = makeKernel('compatible');
    kernel.graph.addNode('köpek', 'köpek', null, { workspaceId: 'default' });
    kernel.graph.addNode('hayvan', 'hayvan', null, { workspaceId: 'default' });
    kernel.graph.addEdge('köpek', 'hayvan', 'tür', { workspaceId: 'default' });

    const signal = detectTypeLatticeConflict(kernel.graph, 'köpek', 'hayvan', 'default');
    assert.strictEqual(signal, null);
  });
});

describe('registerDisjointPair', () => {
  // Uses type names that appear nowhere else so the module-level registration
  // cannot leak into the assertions of the other tests in this file.
  it('makes a newly registered pair conflict through the lattice', () => {
    const kernel = makeKernel('register');
    kernel.graph.addNode('mavi kalem', 'mavi kalem', null, { workspaceId: 'default' });
    kernel.graph.addNode('yazı aracı', 'yazı aracı', null, { workspaceId: 'default' });
    kernel.graph.addEdge('mavi kalem', 'yazı aracı', 'tür', { workspaceId: 'default' });

    assert.strictEqual(
      detectTypeLatticeConflict(kernel.graph, 'mavi kalem', 'silme aracı', 'default'),
      null,
      'unregistered pair must not conflict yet',
    );

    assert.strictEqual(registerDisjointPair('yazı aracı', 'silme aracı'), true);

    const signal = detectTypeLatticeConflict(kernel.graph, 'mavi kalem', 'silme aracı', 'default');
    assert.ok(signal, 'registered pair must now be detected as disjoint');
    assert.strictEqual(signal.rule, 'TYPE_CONFLICT');
  });

  it('is symmetric: the reverse order conflicts too', () => {
    const kernel = makeKernel('register-reverse');
    kernel.graph.addNode('silgi', 'silgi', null, { workspaceId: 'default' });
    kernel.graph.addNode('silme aracı', 'silme aracı', null, { workspaceId: 'default' });
    kernel.graph.addEdge('silgi', 'silme aracı', 'tür', { workspaceId: 'default' });

    const signal = detectTypeLatticeConflict(kernel.graph, 'silgi', 'yazı aracı', 'default');
    assert.ok(signal, 'a pair registered as (a, b) must also conflict as (b, a)');
  });

  it('is idempotent and rejects invalid input', () => {
    assert.strictEqual(registerDisjointPair('yazı aracı', 'silme aracı'), false, 'duplicate');
    assert.strictEqual(registerDisjointPair('silme aracı', 'yazı aracı'), false, 'reversed duplicate');
    assert.strictEqual(registerDisjointPair('hayvan', 'bitki'), false, 'built-in duplicate');
    assert.strictEqual(registerDisjointPair('aynı', 'aynı'), false, 'self-pair');
    assert.strictEqual(registerDisjointPair('', 'bir şey'), false, 'empty left');
    assert.strictEqual(registerDisjointPair('bir şey', null), false, 'missing right');
  });
});
