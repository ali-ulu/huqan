const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../kernel');
const repoMemory = require('../plugins/repo-memory');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-memory-admission-'));

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeKernel(name) {
  const dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
  });
}

test('repo-memory returns explicit error for unsupported action without graph mutation', async () => {
  const kernel = makeKernel('bad-action');

  const result = await repoMemory.run(kernel, {
    action: 'delete',
    sourceType: 'markdown',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported repo-memory action/);
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('repo-memory returns explicit error for unsupported source type without graph mutation', async () => {
  const kernel = makeKernel('bad-source');

  const result = await repoMemory.run(kernel, {
    sourceType: 'unknown',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported sourceType/);
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('repo-memory admission summary reports pending candidates without canonical writes', async () => {
  const kernel = makeKernel('summary');
  const dir = fs.mkdtempSync(path.join(tempRoot, 'summary-doc-'));
  const file = path.join(dir, 'README.md');
  fs.writeFileSync(file, '# One\n\nBody\n\n# Two\n\nBody', 'utf8');

  const result = await repoMemory.run(kernel, {
    sourceType: 'markdown',
    path: file,
    workspaceId: 'workspace-a',
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.status, 'pending');
  assert.equal(result.admission.candidates, 2);
  assert.equal(result.admission.byStatus.pending, 2);
  assert.equal(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length, 2);
  assert.equal(kernel.graph.getEdges(`file:${file}`, 'workspace-a').length, 0);
});
