const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const { detectTypeLatticeConflict, collectTypeAncestors } = require('../lib/type-lattice');

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

    assert.deepStrictEqual(types.slice(0, 3), ['hayvan', 'canlı', 'organizma']);
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
