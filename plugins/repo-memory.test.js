const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoMemory = require('./repo-memory');

function makeKernel() {
  const edges = [];
  const nodes = [];
  return {
    edges,
    nodes,
    graph: {
      addNode(id, label) {
        nodes.push({ id, label });
      },
      addEdge(from, to, relation, meta) {
        const edge = { from, to, relation, meta };
        edges.push(edge);
        return edge;
      },
    },
    hasCapability(name) {
      return name === 'temporal' ? false : true;
    },
  };
}

test('repo-memory markdown ingest requires an explicit root and stays inside it', async () => {
  const kernel = makeKernel();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-root-'));
  const nestedDir = path.join(rootDir, 'docs');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-outside-'));
  const insideFile = path.join(nestedDir, 'safe.md');
  const outsideFile = path.join(outsideDir, 'secret.md');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(insideFile, '# Safe\ninside text', 'utf8');
  fs.writeFileSync(outsideFile, '# Secret\noutside text', 'utf8');

  try {
    const missingRoot = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: insideFile,
    });
    assert.equal(missingRoot.ok, false);
    assert.equal(missingRoot.code, 'MARKDOWN_ROOT_REQUIRED');

    const safe = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: insideFile,
      rootPath: rootDir,
    });
    assert.equal(safe.ok, true);
    assert.equal(safe.files, 1);
    assert.ok(safe.added >= 1);

    const beforeEdges = kernel.edges.length;
    const escaped = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: path.join(rootDir, '..', path.basename(outsideFile)),
      rootPath: rootDir,
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
    assert.equal(kernel.edges.length, beforeEdges);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
