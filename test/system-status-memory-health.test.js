'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { buildSystemStatus, formatSystemStatusText } = require('../lib/system-status-report');
const Kernel = require('../kernel');
const createRepoMemoryPlugin = require('../plugins/repo-memory').create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-status-memory-health-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

function makeKernel(label) {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      evidenceRanking: true,
      temporal: true,
    },
  });
}

test('#3034 acceptance: huqan.status surfaces drift/conflict counts per workspace', async () => {
  const kernel = makeKernel('status-health');
  kernel.usePlugin(createRepoMemoryPlugin());

  const dir = path.join(tempDir, 'ws');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, '# Baslik\nOnce.\n', 'utf8');
  await kernel.runCapability('repoMemory', { action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default' });
  fs.writeFileSync(file, '# Baslik\nSonra.\n', 'utf8');
  await kernel.runCapability('repoMemory', { action: 'ingest', sourceType: 'markdown', path: file, rootPath: dir, workspaceId: 'default' });

  const report = buildSystemStatus(kernel);
  assert.ok(report.memoryHealth);
  assert.equal(report.memoryHealth.driftFindings.pending, 1);

  const text = formatSystemStatusText(report);
  assert.ok(text.includes('Memory health: 1 drift finding(s), 0 conflict candidate(s) pending review'));
});

test('status without memory health (legacy kernel shape) stays quiet, not zero', () => {
  const report = { nodes: 1, edges: 0, entropy: 0, gaps: [], contradictions: [] };
  const text = formatSystemStatusText(report);
  assert.ok(!text.includes('Memory health'));
});

test('a quiet workspace prints no memory-health line', () => {
  const kernel = makeKernel('status-quiet');
  const report = buildSystemStatus(kernel);
  assert.ok(report.memoryHealth);
  assert.equal(report.memoryHealth.driftFindings.pending, 0);
  const text = formatSystemStatusText(report);
  assert.ok(!text.includes('Memory health'));
});
