'use strict';

/**
 * Same guard as test/dashboard-static-assets.test.js (#1894/#1901), applied to
 * the new Control Room shell at /control-room: every same-origin href/src the
 * page links must be declared in lib/http/static-assets.js and actually
 * reachable over HTTP, unauthenticated, with the right content type. Reading
 * the files off disk proves the bytes exist, not that a browser can load them.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const controlRoomHtml = fs.readFileSync(path.join(repoRoot, 'public', 'control-room', 'index.html'), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-control-room-static-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

function linkedAssetPaths(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:href|src)\s*=\s*["'](\/[^"'#?]*)["']/gi)) {
    const value = match[1];
    if (value === '/') continue;
    // github.com is an external, cross-origin link (the bug-report button);
    // this suite only covers assets this server itself must serve.
    if (/^https?:\/\//i.test(value)) continue;
    found.add(value);
  }
  return [...found].sort();
}

function probe(paths) {
  const caseDir = fs.mkdtempSync(path.join(tempDir, 'case-'));
  const script = `
    const http = require('http');
    const path = require('path');
    const paths = JSON.parse(process.argv[2]);
    Object.assign(process.env, {
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: 'test-key',
      HUQAN_MEMORY_PATH: path.join(process.argv[1], 'memory.json'),
      HUQAN_DB_PATH: path.join(process.argv[1], 'graph.sqlite'),
    });
    const server = require(path.join(${JSON.stringify(repoRoot)}, 'server.js'));
    function get(urlPath) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET' }, (res) => {
          let bytes = 0;
          res.on('data', (chunk) => { bytes += chunk.length; });
          res.on('end', () => resolve({ path: urlPath, status: res.statusCode, contentType: res.headers['content-type'] || null, bytes }));
        });
        req.on('error', reject);
        req.end();
      });
    }
    (async () => {
      let result;
      try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        result = [];
        for (const urlPath of paths) result.push(await get(urlPath));
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        try { server.closeHuqan(); } catch (_) {}
      }
      process.stdout.write('STATIC_ASSETS ' + JSON.stringify(result) + '\\n');
    })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script, caseDir, JSON.stringify(paths)], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = output.split('\n').find(l => l.startsWith('STATIC_ASSETS '));
  assert.ok(line, `no probe result in output:\n${output}`);
  return JSON.parse(line.slice('STATIC_ASSETS '.length));
}

test('control room static assets', async (t) => {
  const linked = linkedAssetPaths(controlRoomHtml);

  await t.test('the control room shell links at least one same-origin asset', () => {
    assert.ok(linked.length > 0, 'expected public/control-room/index.html to link a same-origin asset');
  });

  await t.test('every linked asset is declared as a served static asset', () => {
    const { listStaticAssetPaths } = require('../lib/http/static-assets');
    const declared = new Set(listStaticAssetPaths());
    const undeclared = linked.filter(p => !declared.has(p));
    assert.deepEqual(undeclared, [], `public/control-room/index.html links paths with no entry in lib/http/static-assets.js: ${undeclared.join(', ')}`);
  });

  await t.test('every linked asset is reachable over HTTP without an API key', () => {
    const results = probe(['/control-room', ...linked]);
    for (const result of results) {
      assert.equal(result.status, 200, `${result.path} answered ${result.status}; a linked asset that 404s renders the panel broken while every source-text test still passes`);
      assert.ok(result.bytes > 0, `${result.path} served an empty body`);
    }
  });

  await t.test('the stylesheet is served as CSS and scripts as JavaScript', () => {
    const [stylesheet] = probe(['/control-room/css/control-room.css']);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.contentType || '', /^text\/css\b/);

    const scripts = linked.filter(p => p.endsWith('.js'));
    const results = probe(scripts);
    for (const result of results) {
      assert.match(result.contentType || '', /javascript/, `${result.path} should be served as JavaScript, got ${result.contentType}`);
    }
  });

  await t.test('every declared control-room route is authorized as public in route-auth-policy', () => {
    const { isPublicRoute } = require('../lib/http/route-auth-policy');
    for (const urlPath of ['/control-room', ...linked]) {
      assert.equal(isPublicRoute(urlPath, 'GET'), true, `${urlPath} should be a public route in lib/http/route-auth-policy.js`);
    }
  });
});
