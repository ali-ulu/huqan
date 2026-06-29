const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-semantic-negation-'));
const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });

  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

describe('semantic parser negation admission guard', () => {
  it('does not turn a Turkish negated claim into a positive type fact', () => {
    const kernel = makeKernel('negated-claim');

    const learn = unwrap(kernel.learn('AXIOM bir LLM değildir', { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS }));
    assert.strictEqual(learn.learned, 1);

    const subject = kernel.normalizeWord('AXIOM');
    const object = kernel.normalizeWord('LLM');
    const typeEdge = kernel.graph.getEdge(subject, object, 'tür', 'default');
    const negationEdge = kernel.graph.getEdges(subject, 'default').find(edge => edge.relation === 'değil');

    assert.strictEqual(typeEdge, null, 'negated learn must not create a positive tür edge');
    assert.ok(negationEdge, 'negated learn should still record a negation edge');

    const verify = unwrap(kernel.verify('AXIOM bir LLM dir', { workspaceId: 'default' }));
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(verify.status), 'status contract must stay stable');
    assert.notStrictEqual(verify.status, 'dogrulandi', 'positive claim must not become verified after negation');
  });

  it('rejects malformed parsed facts before graph admission', () => {
    const kernel = makeKernel('malformed-facts');
    kernel.extractFacts = () => ([
      { subject: undefined, predicate: 'AXIOM bir LLM değildir' },
      { subject: 'axiom', predicate: undefined },
      { subject: 'axiom', predicate: '' },
      { subject: 'axiom', predicate: null },
    ]);

    const learn = unwrap(kernel.learn('ignored input', { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS }));
    assert.strictEqual(learn.learned, 0);
    assert.strictEqual(kernel.graph.nodeCount('default'), 0);
    assert.strictEqual(kernel.graph.edgeCount('default'), 0);
  });

  it('keeps normal positive learn working', () => {
    const kernel = makeKernel('positive-learn');

    const learn = unwrap(kernel.learn('Beta bir sistemdir', { workspaceId: 'default', ...TEST_FIXTURE_LEARN_BYPASS }));
    assert.strictEqual(learn.learned, 1);

    const verify = unwrap(kernel.verify('Beta bir sistemdir', { workspaceId: 'default' }));
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(verify.status), 'status contract must stay stable');
    assert.strictEqual(verify.status, 'dogrulandi');
  });
});
