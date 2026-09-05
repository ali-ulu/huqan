'use strict';

/**
 * Every asset the dashboard links must actually be served.
 *
 * This suite exists because of a specific failure. #1894 moved ~20KB of CSS out
 * of the inline `<style>` into `public/css/app.css` and pointed a `<link>` at
 * `/css/app.css`. Nothing served that path. The panel rendered completely
 * unstyled in a browser, and not one test noticed -- the source-text contract
 * tests read the HTML file and the extracted file directly off disk, so they saw
 * a complete stylesheet and passed. #1900 then adapted one of those tests to
 * follow the link, which made the reading correct and left the 404 in place.
 *
 * The lesson is that reading the asset off disk proves the bytes exist, not that
 * a browser can get them. So this file asks the running server over HTTP, and it
 * derives the list of paths from the HTML rather than restating it: extracting
 * another asset without declaring it in lib/http/static-assets.js fails here
 * instead of silently shipping a blank panel.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-static-assets-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

/**
 * Same-origin `href`/`src` references in the dashboard HTML.
 *
 * Root-relative only: absolute URLs belong to another origin and `data:` URIs
 * carry their own bytes, so neither is this server's to serve.
 */
function linkedAssetPaths(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:href|src)\s*=\s*["'](\/[^"'#?]*)["']/gi)) {
    const value = match[1];
    if (value === '/') continue;
    found.add(value);
  }
  return [...found].sort();
}

// Booting in-process would leave SQLite handles and listeners in this runner;
// server.js is required by many other suites. A child process keeps it isolated.
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
    // No API key is sent on purpose: the page that links these assets is public,
    // so a browser that can load '/' must be able to load them unauthenticated.
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

test('dashboard static assets', async (t) => {
  const linked = linkedAssetPaths(indexHtml);

  await t.test('the dashboard links at least one extracted asset', () => {
    // Guards the guard: if the HTML goes back to being fully inline this suite
    // would pass vacuously, and the reader should be told why it stopped
    // covering anything rather than trusting a green tick.
    assert.ok(linked.length > 0, 'expected public/index.html to link a same-origin asset');
  });

  await t.test('every linked asset is declared as a served static asset', () => {
    const { listStaticAssetPaths } = require('../lib/http/static-assets');
    const declared = new Set(listStaticAssetPaths());
    const undeclared = linked.filter(p => !declared.has(p));
    assert.deepEqual(undeclared, [], `public/index.html links paths with no entry in lib/http/static-assets.js: ${undeclared.join(', ')}`);
  });

  await t.test('every linked asset is reachable over HTTP without an API key', () => {
    const results = probe(linked);
    for (const result of results) {
      assert.equal(result.status, 200, `${result.path} answered ${result.status}; a linked asset that 404s renders the panel broken while every source-text test still passes`);
      assert.ok(result.bytes > 0, `${result.path} served an empty body`);
    }
  });

  await t.test('the stylesheet is served as CSS', () => {
    // A stylesheet served as application/json is dropped by the browser exactly
    // like a 404, so the status code alone is not the whole assertion.
    const [stylesheet] = probe(['/css/app.css']);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.contentType || '', /^text\/css\b/);
  });

  await t.test('an undeclared path under a served asset directory stays a 404', () => {
    // The served surface is an explicit table, not a directory: a traversal or a
    // guess at a neighbouring file must not reach the file system.
    const [guess] = probe(['/css/../server.js']);
    assert.equal(guess.status, 404);
  });
});
