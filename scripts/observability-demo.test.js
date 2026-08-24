'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const net = require('node:net');
const { seedDemo, serveDemo, WORKSPACE } = require('./observability-demo');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try { const response = await fetch(url); if (response.ok) return response; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

test('single-command seed produces a real isolated AgentV3 run readable from the server database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-demo-test-'));
  const output = path.join(root, 'demo');
  try {
    const seeded = seedDemo({ output });
    assert.equal(seeded.report.demo, true);
    assert.equal(seeded.report.workspaceId, WORKSPACE);
    assert.equal(seeded.report.eventTypes.includes('run_started'), true);
    assert.equal(seeded.report.eventTypes.includes('step_finished'), true);
    assert.equal(seeded.report.eventTypes.includes('run_finished'), true);
    const db = new Database(seeded.databasePath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observability_runs WHERE workspace_id = ?').get(WORKSPACE).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observability_events WHERE workspace_id = ?').get(WORKSPACE).count >= 3, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observability_runs WHERE workspace_id <> ?").get(WORKSPACE).count, 0);
    db.close();
    assert.doesNotMatch(fs.readFileSync(path.join(output, 'demo-report.json'), 'utf8'), /prompt|credential|api.?key/i);
    assert.throws(() => seedDemo({ output }), { code: 'OBSERVABILITY_DEMO_DIRECTORY_NOT_EMPTY' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('single-command demo serves the real dashboard and both authenticated observability API prefixes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-demo-server-test-'));
  const output = path.join(root, 'demo');
  const port = await availablePort();
  let runtime;
  try {
    seedDemo({ output });
    runtime = serveDemo({ directory: output, port, stdio: 'ignore', announce: false });
    const index = await waitForServer(`http://127.0.0.1:${port}/`);
    assert.match(await index.text(), /Trust Command Center/i);
    const headers = { Authorization: `Bearer ${runtime.apiKey}` };
    for (const prefix of ['/api/observability', '/api/v1/observability']) {
      const response = await fetch(`http://127.0.0.1:${port}${prefix}/metrics?workspaceId=${WORKSPACE}`, { headers });
      const responseText = await response.text();
      assert.equal(response.status, 200, `${prefix}: ${responseText}`);
      const body = JSON.parse(responseText);
      assert.equal(body.ok, true);
      assert.equal(body.data.metrics.totalRuns, 1);
    }
  } finally {
    runtime?.child.kill();
    if (runtime?.child.exitCode === null) await new Promise(resolve => runtime.child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
