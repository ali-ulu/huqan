'use strict';

const SERVER = `'use strict';
const http = require('node:http');
const routes = require('../routes.json');

function createServer() {
  return http.createServer((request, response) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const route = routes.find(entry => entry.path === pathname);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!route) { response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' })); return; }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405); response.end(JSON.stringify({ error: 'method_not_allowed' })); return;
    }
    response.writeHead(200); response.end(JSON.stringify(route.body));
  });
}

if (require.main === module) createServer().listen(Number(process.env.PORT || 3000), '127.0.0.1');
module.exports = { createServer };
`;

function projectFiles(spec) {
  const expected = JSON.stringify(JSON.stringify(spec.routes));
  const tests = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const expected = JSON.parse(${expected});

test('declared GET requirements and HTTP refusal boundaries', async (t) => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of expected) {
    const response = await fetch(base + route.path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\\/json/);
    assert.deepEqual(await response.json(), route.body);
  }
  let missing = '/missing';
  while (expected.some(route => route.path === missing)) missing += '-route';
  const absent = await fetch(base + missing);
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), { error: 'not_found' });
  const unsupported = await fetch(base + expected[0].path, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
});
`;
  return {
    'package.json': `${JSON.stringify({ name: spec.name, version: '0.0.0', private: true,
      scripts: { start: 'node src/server.js', test: 'node --test test/api.test.js' },
      engines: { node: '>=22.13.0' } }, null, 2)}\n`,
    'routes.json': `${JSON.stringify(spec.routes, null, 2)}\n`,
    'src/server.js': SERVER,
    'test/api.test.js': tests,
    'README.md': `# ${spec.name}\n\nLocal JSON API. Requires Node 22.13 or later.\n\n`
      + 'Run `node src/server.js`; the service listens on 127.0.0.1:3000.\n'
      + 'Run `node --test test/api.test.js` to check the declared routes, 404 and 405.\n'
      + 'No dependencies are required. Authentication, storage and deployment are outside this contract.\n',
  };
}

module.exports = { projectFiles };
