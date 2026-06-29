const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('./kernel');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

test('company-mode: learn attaches company metadata when capability is enabled', () => {
  const k = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    capabilities: { companyMode: true },
  });

  k.learn('kedi hayvandir', {
    sourceType: 'manual',
    sourceRef: 'manual:sonfi:2026-05-31',
    sessionId: 'session-1',
    companyMode: true,
    ...TEST_FIXTURE_LEARN_BYPASS,
  });

  const edges = k.graph.getEdges('kedi');
  assert.equal(edges.length > 0, true);
  const edge = edges[0];
  assert.equal(edge.source_type, 'manual');
  assert.equal(edge.source_ref, 'manual:sonfi:2026-05-31');
  assert.equal(edge.session_id, 'session-1');
  assert.equal(edge.company_mode, 1);
});

test('company-mode: learn ignores company metadata when company capability is disabled', () => {
  const k = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    capabilities: { companyMode: false },
  });

  k.learn('kopek hayvandir', {
    sourceType: 'manual',
    sourceRef: 'manual:sonfi:2026-05-31',
    companyMode: true,
    ...TEST_FIXTURE_LEARN_BYPASS,
  });

  const edges = k.graph.getEdges('kopek');
  assert.equal(edges.length > 0, true);
  const edge = edges[0];
  assert.equal(edge.company_mode || 0, 0);
});
