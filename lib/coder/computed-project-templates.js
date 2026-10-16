'use strict';

function expression(tree) {
  if (tree.type === 'acc' || tree.type === 'item') return tree.type;
  if (tree.type === 'integer') return String(tree.value);
  return `checked(${expression(tree.left)} ${tree.operator} ${expression(tree.right)})`;
}

const SERVER = `'use strict';
const http = require('node:http');
const routes = require('../routes.json');
const { compute } = require('./logic');
function createServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => { if (!response.writableEnded && !response.destroyed) { response.writeHead(status); response.end(JSON.stringify(body)); } };
    request.on('error', () => send(400, { error: 'invalid_request' }));
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { send(400, { error: 'invalid_request' }); return; }
    const route = routes.findIndex(entry => entry.path === pathname);
    if (route < 0) { request.resume(); send(404, { error: 'not_found' }); return; }
    if (request.method !== 'POST') { request.resume(); response.setHeader('Allow', 'POST'); send(405, { error: 'method_not_allowed' }); return; }
    let size = 0;
    let stopped = false;
    const chunks = [];
    request.setTimeout(5000, () => { stopped = true; send(408, { error: 'request_timeout' }); request.destroy(); });
    request.on('aborted', () => { stopped = true; });
    request.on('error', () => { stopped = true; send(400, { error: 'invalid_request' }); });
    request.on('data', chunk => {
      if (stopped) return;
      size += chunk.length;
      if (size > 8192) { stopped = true; chunks.length = 0; send(413, { error: 'body_too_large' }); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (stopped) return;
      request.setTimeout(0);
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { send(400, { error: 'invalid_json' }); return; }
      if (!Array.isArray(input) || input.length > 128 || !input.every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0))) {
        send(400, { error: 'invalid_input' }); return;
      }
      try { send(200, { result: compute(route, input) }); }
      catch { send(422, { error: 'invalid_computation' }); }
    });
  });
  server.requestTimeout = 5000;
  return server;
}
if (require.main === module) createServer().listen(Number(process.env.PORT || 3000), '127.0.0.1');
module.exports = { createServer };
`;

function guardPrefix(program) {
  return ['guarded-fold', 'threshold-fold'].includes(program.type) ? `if (!(item ${program.guard.operator} ${program.guard.threshold})) continue; ` : '';
}

function compileMethod(program) {
  if (program.type === 'scalar-composition') {
    const scalar = tree => Object.hasOwn(tree, 'source') ? `values[${tree.source}]`
      : `scalarChecked(${scalar(tree.left)} ${tree.operator} ${scalar(tree.right)})`;
    return `input => { const values = [${program.sources.map(source => `scalarChecked((${compileMethod(source)})(input))`).join(', ')}]; return ${scalar(program.expression)}; }`;
  }
  if (program.type === 'stateful-fold') return `input => { if (!input.length) return ${program.emptyResult}; let acc = ${program.seed === 'first' ? 'input[0]' : program.emptyResult}; for (let at = ${program.seed === 'first' ? 1 : 0}; at < input.length; at += 1) { const item = input[at]; if (item ${program.guard.operator} acc) acc = ${expression(program.update)}; } return acc; }`;
  if (program.type === 'filter') return `input => input.filter(item => item ${program.guard.operator} ${program.guard.threshold})`;
  if (program.type === 'pipeline') return `input => { let value = input; ${program.stages.map(stage =>
    `value = (${compileMethod(stage)})(pipelineInput(value)); `).join('')}return value; }`;
  if (program.type === 'map') return `input => { const output = []; for (const item of input) { const value = ${expression(program.expression)}; if (Object.is(value, -0)) throw new RangeError('invalid_computation'); output.push(value); } return output; }`;
  return `input => { let acc = ${program.seed}; for (const item of input) { ${guardPrefix(program)}acc = ${expression(program.update)}; } return acc; }`;
}

function computedProjectFiles(spec, programs) {
  const objectRequests = spec.routes.some(route => route.inputField !== undefined);
  const maps = programs.some(row => ['map', 'filter'].includes(row.program.type))
    || spec.routes.some(route => route.pipeline?.type === 'pipeline' && ['map', 'filter'].includes(route.pipeline.stages.at(-1).type));
  const resultDescription = maps ? 'numeric, integer-array or declared object results'
    : spec.routes.some(route => route.compose) ? 'numeric or declared object results' : 'a numeric result';
  const shape = route => route.inputField === undefined ? {} : { inputField: route.inputField };
  const server = objectRequests ? SERVER.replace('      if (!Array.isArray(input)', `      const field = routes[route].inputField;
      if (field !== undefined) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, field)) {
          send(400, { error: 'invalid_input' }); return;
        }
        input = input[field];
      }
      if (!Array.isArray(input)`) : SERVER;
  const compiled = spec.routes.map(route => {
    if (route.pipeline?.type === 'pipeline') return compileMethod(route.pipeline);
    if (route.pipeline) return 'input => { let value = input; ' + route.pipeline.map(target =>
      `value = programs[${spec.routes.findIndex(entry => entry.path === target)}](pipelineInput(value)); `).join('') + 'return value; }';
    if (route.compose) return 'input => ({ ' + Object.entries(route.compose).map(([name, path]) =>
      `${JSON.stringify(name)}: programs[${spec.routes.findIndex(entry => entry.path === path)}](input)`).join(', ') + ' })';
    const row = programs.find(entry => entry.path === route.path);
    if (['filter', 'stateful-fold', 'scalar-composition'].includes(row.program.type)) return compileMethod(row.program);
    if (row.program.type === 'map') return `input => { const output = []; for (const item of input) { const value = ${expression(row.program.expression)}; if (Object.is(value, -0)) throw new RangeError('invalid_computation'); output.push(value); } return output; }`;
    return `input => { let acc = ${row.program.seed}; for (const item of input) { ${guardPrefix(row.program)}acc = ${expression(row.program.update)}; } return acc; }`;
  });
  const logic = `'use strict';\nconst checked = value => { if (!Number.isSafeInteger(value)) throw new RangeError('invalid_computation'); return value; };\n`
    + (programs.some(row => row.program.type === 'scalar-composition') ? 'const scalarChecked = value => { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new RangeError("invalid_computation"); return value; };\n' : '')
    + (spec.routes.some(route => route.pipeline) ? 'const pipelineInput = value => { if (!Array.isArray(value) || value.length > 128 || !value.every(item => Number.isSafeInteger(item) && Math.abs(item) <= 1000000 && !Object.is(item, -0))) throw new RangeError("invalid_computation"); return value; };\n' : '')
    + 'const programs = [\n' + compiled.join(',\n')
    + '\n];\nmodule.exports = { compute: (route, input) => programs[route](input) };\n';
  const expected = JSON.stringify(JSON.stringify(spec.routes.map(route => ({ path: route.path, ...shape(route), examples: route.compose || route.pipeline || route.composeScalar ? route.acceptanceExamples : route.compute.acceptanceExamples }))));
  const request = objectRequests ? 'route.inputField === undefined ? row.input : { [route.inputField]: row.input }' : 'row.input';
  const tests = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const expected = JSON.parse(${expected});
test('independent POST acceptance and HTTP boundaries', async t => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body) => fetch(base + path, { method: 'POST', body });
  for (const route of expected) for (const row of route.examples) {
    const response = await post(route.path, JSON.stringify(${request}));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: row.expected });
  }
  ${objectRequests ? `for (const route of expected.filter(entry => entry.inputField !== undefined)) {
    const field = JSON.stringify(route.inputField);
    for (const value of ['null', '{}', '[1.5]', '[-0]', '[1000001]', JSON.stringify(Array(129).fill(1))]) {
      assert.equal((await post(route.path, '{' + field + ':' + value + '}')).status, 400);
    }
    for (const body of ['[]', '{}', 'null', JSON.stringify({ [route.inputField]: [], extra: 1 })])
      assert.equal((await post(route.path, body)).status, 400);
  }
  ` : ''}const path = expected[0].path;
  for (const body of ['invalid', '{}', '[1.5]', '[-0]', JSON.stringify(Array(129).fill(1)), '[1000001]']) assert.equal((await post(path, body)).status, 400);
  assert.equal((await post(path, ' '.repeat(8193))).status, 413);
  const method = await fetch(base + path);
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
  let missing = '/missing'; while (expected.some(route => route.path === missing)) missing += '-route';
  assert.equal((await post(missing, '[]')).status, 404);
});
`;
  return {
    'package.json': JSON.stringify({ name: spec.name, version: '0.0.0', private: true,
      scripts: { start: 'node src/server.js', test: 'node --test test/api.test.js' }, engines: { node: '>=22.13.0' } }, null, 2) + '\n',
    'routes.json': JSON.stringify(spec.routes.map(route => ({ path: route.path, ...shape(route) })), null, 2) + '\n',
    'src/server.js': server, 'src/logic.js': logic, 'test/api.test.js': tests,
    'README.md': `# ${spec.name}\n\nLocal computed JSON API. Requires Node 22.13 or later.\n\n`
      + 'Run `node src/server.js` (127.0.0.1:3000) and `node --test test/api.test.js`.\n'
      + (objectRequests ? `POST a JSON integer array, or a single-field object for routes declaring inputField in routes.json; responses contain ${resultDescription}.\n`
        : `POST a JSON integer array to a declared route; responses contain ${resultDescription}.\n`)
      + 'Body limit: 8192 bytes; array limit: 128 integers within +/-1000000. Invalid input is refused.\n'
      + `Algorithms are bounded ${maps ? 'array' : 'array-fold'} operator compositions inferred from training examples. Independent acceptance examples are tested over HTTP.\n`
      + 'Authentication, storage and deployment are outside this contract.\n',
  };
}

module.exports = { computedProjectFiles };
