'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { produceComputedProject } = require('../lib/coder/project-compute');
const specification = () => ({ kind: 'project_spec', name: 'computed-demo', archetype: 'node_computed_json_api',
  routes: [{ path: '/calculate', compute: { family: 'array-fold', examples: [
    { input: [], expected: 0 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 7 },
  ], acceptanceExamples: [
    { input: [-3, 8], expected: 5 }, { input: [1, 1, 1], expected: 3 }, { input: [20], expected: 20 },
  ] } }] });

test('produces precisely six deterministic files with an actual inferred loop', () => {
  const spec = specification();
  const result = produceComputedProject(spec);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.files), ['package.json', 'routes.json', 'src/server.js', 'src/logic.js', 'test/api.test.js', 'README.md']);
  assert.match(result.files['src/logic.js'], /for \(const item of input\)/);
  assert.match(result.files['src/logic.js'], /checked\(acc \+ item\)/);
  assert.equal(JSON.parse(result.files['package.json']).version, '0.0.0');
  assert.deepEqual(produceComputedProject(spec), result);
  spec.routes[0].compute.acceptanceExamples[0].expected = 999;
  const wrong = produceComputedProject(spec);
  assert.equal(wrong.ok, true);
  assert.equal(wrong.files['src/logic.js'], result.files['src/logic.js']);
  assert.deepEqual(wrong.computation, result.computation);
});

test('refuses executable input, unknown properties, bounds and overlapping holdouts', () => {
  let invoked = false;
  const accessor = specification();
  Object.defineProperty(accessor, 'name', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.equal(produceComputedProject(accessor).ok, false);
  assert.equal(invoked, false);
  const proxy = new Proxy({}, { get() { invoked = true; throw new Error('executed'); } });
  assert.equal(produceComputedProject(proxy).ok, false);
  assert.equal(invoked, false);
  for (const mutate of [
    spec => { spec.code = 'arbitrary'; },
    spec => { spec.routes[0].compute.expression = 'input'; },
    spec => { spec.routes[0].compute.family = 'sum'; },
    spec => { spec.routes[0].compute.acceptanceExamples[0].input = []; },
    spec => { spec.routes[0].compute.examples[0].expected = -0; },
    spec => { spec.routes[0].compute.examples[1].input = Array(129).fill(1); },
    spec => { spec.routes[0].compute.examples[1].input = [1000001]; },
    spec => { spec.routes[0].compute.examples[1].input = Array(2); },
    spec => { spec.routes[0].path = '/../unsafe'; },
  ]) { const spec = specification(); mutate(spec); assert.equal(produceComputedProject(spec).ok, false); }
});

test('generated acceptance tests run against real HTTP and reject an incorrect holdout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computed-api-'));
  try {
    const write = spec => {
      const result = produceComputedProject(spec);
      assert.equal(result.ok, true);
      for (const [relative, content] of Object.entries(result.files)) {
        const absolute = path.join(root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
      }
    };
    write(specification());
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ['--test', 'test/api.test.js'], { cwd: root, encoding: 'utf8', timeout: 20000,
      env, windowsHide: true });
    const passing = run();
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    const wrong = specification(); wrong.routes[0].compute.acceptanceExamples[0].expected = 999;
    write(wrong);
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /AssertionError|ERR_ASSERTION/);
    const inferred = specification(); delete inferred.routes[0].compute.family;
    inferred.routes[0].compute.examples = [
      { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [-3, 4], expected: [-6, 8] },
    ];
    inferred.routes[0].compute.acceptanceExamples = [
      { input: [5], expected: [10] }, { input: [-2], expected: [-4] }, { input: [1, 3], expected: [2, 6] },
    ];
    inferred.routes.push({ ...structuredClone(inferred.routes[0]), path: '/double-again' }, {
      path: '/quadruple', pipeline: ['/calculate', '/double-again'], acceptanceExamples: [
        { input: [5], expected: [20] }, { input: [-2], expected: [-8] }, { input: [1, 3], expected: [4, 12] },
      ],
    }, { path: '/pair', compose: { left: '/calculate', right: '/double-again' }, acceptanceExamples: [
      { input: [5], expected: { left: [10], right: [10] } },
      { input: [-2], expected: { left: [-4], right: [-4] } },
      { input: [1, 3], expected: { left: [2, 6], right: [2, 6] } },
    ] });
    write(inferred);
    const inferredPass = run();
    assert.equal(inferredPass.status, 0, inferredPass.stdout + inferredPass.stderr);
    inferred.routes[0].compute.acceptanceExamples[0].expected = [999];
    write(inferred);
    assert.notEqual(run().status, 0);
    const product = specification();
    product.routes[0].compute.examples = [
      { input: [], expected: 1 }, { input: [2], expected: 2 }, { input: [3, 4], expected: 12 },
    ];
    product.routes[0].compute.acceptanceExamples = [
      { input: [5, 6], expected: 30 }, { input: [1, 1, 1], expected: 1 }, { input: [20], expected: 20 },
    ];
    write(product);
    fs.appendFileSync(path.join(root, 'test/api.test.js'), `
test('overflow is refused over HTTP', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/calculate',
    { method: 'POST', body: '[1000000,1000000,1000000]' });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'invalid_computation' });
});
test('stalled request body terminates within a bounded interval', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const started = Date.now();
  const socket = require('node:net').connect(server.address().port, '127.0.0.1');
  let output = '';
  let socketError = null;
  socket.on('data', chunk => { output += chunk.toString(); });
  socket.on('error', error => { socketError = error; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('stalled request did not terminate')); }, 10000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('connect', () => socket.write('POST /calculate HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 100\\r\\n\\r\\n['));
  });
  assert.ok(Date.now() - started < 10000);
  assert.ok(output.includes('408') || output === '' || socketError !== null);
});
`);
    const overflowing = run();
    assert.equal(overflowing.status, 0, overflowing.stdout + overflowing.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
