const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('./kernel');
const createContradictionAlertPlugin = require('./plugins/contradiction-alert').create;

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

test('contradiction-alert: detects direct contradiction and returns conflict details', async () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { temporal: true } });
  k.learn('kedi hayvandir', TEST_FIXTURE_LEARN_BYPASS);
  k.usePlugin(createContradictionAlertPlugin());

  const result = await k.plugins.runCapability('contradictionAlert', { text: 'kedi hayvan degildir' });
  assert.equal(result.ok, true);
  assert.equal(result.data.newThought.includes('kedi'), true);
  assert.equal(Array.isArray(result.data.conflictingThoughts), true);
  assert.equal(result.data.conflictingThoughts.length > 0, true);
  assert.equal(result.data.conflictType, 'direct');
});

test('contradiction-alert: returns empty list and null conflictType when no conflict', async () => {
  const k = new Kernel({ noLoad: true, loadPlugins: false, capabilities: { temporal: true } });
  k.learn('kedi hayvandir', TEST_FIXTURE_LEARN_BYPASS);
  k.usePlugin(createContradictionAlertPlugin());

  const result = await k.plugins.runCapability('contradictionAlert', { text: 'kedi sevimlidir' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.conflictingThoughts, []);
  assert.equal(result.data.conflictType, null);
});

test('contradiction-alert: includes temporal metadata and evidence quality when enabled', async () => {
  const k = new Kernel({
    noLoad: true,
    loadPlugins: false,
    capabilities: { temporal: true, evidenceRanking: true },
  });

  k.learn('kus ucar', TEST_FIXTURE_LEARN_BYPASS);
  k.usePlugin(createContradictionAlertPlugin());

  const result = await k.plugins.runCapability('contradictionAlert', { text: 'kus ucmaz' });
  assert.equal(result.ok, true);
  assert.equal(result.data.conflictingThoughts.length > 0, true);

  const first = result.data.conflictingThoughts[0];
  assert.equal(typeof first.created_at, 'string');
  assert.equal(typeof first.age_ms, 'number');
  assert.equal(typeof first.adjustedConfidence, 'number');
  assert.equal(typeof result.data.evidenceQuality, 'number');
});
