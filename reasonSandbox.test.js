const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('./kernel');

test('reasonSandbox: learns and answers without touching the real graph', async () => {
  const k = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  const before = k.graph.getStats();

  const res = await k.reasonSandbox({
    learn: ['elma meyvedir'],
    ask: ['elma nedir'],
  });

  assert.ok(res.backend === 'rust' || res.backend === 'js');
  assert.strictEqual(res.answers.length, 1);
  assert.strictEqual(typeof res.answers[0], 'string');

  // The sandbox must be fully isolated from the kernel's own knowledge graph.
  const after = k.graph.getStats();
  assert.deepStrictEqual(after, before);
});

test('reasonSandbox: unknown question answers Bilmiyorum on both backends', async () => {
  const k = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });

  const rustForced = k._rust ? await k.reasonSandbox({ ask: ['bilinmeyen nedir'] }) : null;
  if (rustForced) assert.strictEqual(rustForced.answers[0], 'Bilmiyorum');

  const savedRust = k._rust;
  k._rust = null;
  const jsForced = await k.reasonSandbox({ ask: ['bilinmeyen nedir'] });
  k._rust = savedRust;
  assert.strictEqual(jsForced.backend, 'js');
  assert.strictEqual(jsForced.answers[0], 'Bilmiyorum');
});

test('reasonSandbox: empty input returns no answers on either backend', async () => {
  const k = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  const res = await k.reasonSandbox({});
  assert.deepStrictEqual(res.answers, []);
});
