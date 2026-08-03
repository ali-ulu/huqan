const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Graph = require('./graph');

const RUST_BIN_CANDIDATES = [
  path.join(__dirname, 'axiom-core', 'target', 'release', process.platform === 'win32' ? 'axiom-core.exe' : 'axiom-core'),
  path.join(__dirname, 'axiom-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'axiom-core.exe'),
];
const RUST_BIN = RUST_BIN_CANDIDATES.find(p => fs.existsSync(p));
const hasRust = !!RUST_BIN;

function rustExec(cmds) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RUST_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Rust exit ${code}: ${stderr}`));
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolve(lines.map(l => JSON.parse(l)));
    });
    proc.stdin.end(cmds.map(c => JSON.stringify(c)).join('\n'));
  });
}

describe('RustGraph - JS ile Karşılaştırma', { skip: !hasRust }, () => {

  it('add_node: düğüm oluşturur', async () => {
    const res = await rustExec([{ cmd: 'add_node', id: 'kedi', label: 'kedi' }]);
    assert.strictEqual(res[0].ok, true);
  });

  it('add_node + add_edge + get_edges: JS ile aynı', async () => {
    const g = new Graph();
    g.addNode('kedi', 'kedi');
    g.addNode('hayvan', 'hayvan');
    g.addEdge('kedi', 'hayvan', 'tür');
    const jsEdges = g.getEdges('kedi');

    const res = await rustExec([
      { cmd: 'add_node', id: 'kedi', label: 'kedi' },
      { cmd: 'add_node', id: 'hayvan', label: 'hayvan' },
      { cmd: 'add_edge', from: 'kedi', to: 'hayvan', relation: 'tür' },
      { cmd: 'get_edges', id: 'kedi' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[2].ok, true);
    assert.strictEqual(res[3].ok, true);
    assert.strictEqual(res[3].edges.length, jsEdges.length);
    assert.strictEqual(res[3].edges[0].relation, 'tür');
  });

  it('learn + ask: bilgi öğrenir ve yanıtlar', async () => {
    const g = new Graph();
    g.addNode('elma', 'elma');
    g.addNode('meyve', 'meyve');
    g.addEdge('elma', 'meyve', 'tür');
    g.addNode('kırmızı', 'kırmızı');
    g.addEdge('elma', 'kırmızı', 'özellik');
    const jsEdges = g.getEdges('elma');
    const jsTypes = jsEdges.filter(e => e.relation === 'tür').map(e => e.to);

    const res = await rustExec([
      { cmd: 'add_node', id: 'elma', label: 'elma' },
      { cmd: 'add_node', id: 'meyve', label: 'meyve' },
      { cmd: 'add_edge', from: 'elma', to: 'meyve', relation: 'tür' },
      { cmd: 'add_node', id: 'kırmızı', label: 'kırmızı' },
      { cmd: 'add_edge', from: 'elma', to: 'kırmızı', relation: 'özellik' },
      { cmd: 'ask', question: 'elma nedir' },
      { cmd: 'get_node', id: 'elma' },
    ]);

    const jsAnswer = `elma ${jsEdges.map(e => e.to).join(', ')}`;
    const rustAnswer = res[5].answer;

    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[2].ok, true);
    assert.strictEqual(res[3].ok, true);
    assert.strictEqual(res[4].ok, true);
    assert.strictEqual(res[5].ok, true);
    assert.ok(rustAnswer.startsWith('elma'));
    assert.strictEqual(res[6].ok, true);
  });

  it('remove_node: düğüm siler', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'silinecek', label: 'silinecek' },
      { cmd: 'remove_node', id: 'silinecek' },
      { cmd: 'get_node', id: 'silinecek' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[2].ok, false);
  });

  it('cosine_similarity: benzerlik hesaplar', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'a', label: 'a' },
      { cmd: 'add_node', id: 'b', label: 'b' },
      { cmd: 'add_edge', from: 'a', to: 'c', relation: 'ortak' },
      { cmd: 'add_edge', from: 'b', to: 'c', relation: 'ortak' },
      { cmd: 'cosine_similarity', a: 'a', b: 'b' },
    ]);
    assert.strictEqual(res[4].ok, true);
    assert.strictEqual(res[4].similarity, 0);
  });

  it('prune + optimize: temizlik yapar', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'x', label: 'x' },
      { cmd: 'prune', threshold: '0.5' },
      { cmd: 'optimize' },
      { cmd: 'stats' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.ok(res[1].pruned >= 0);
    assert.strictEqual(res[2].ok, true);
    assert.strictEqual(res[3].ok, true);
    assert.ok(res[3].stats.nodes >= 1);
  });

  it('get_in_edges: ters kenarları bulur', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'ebeveyn', label: 'ebeveyn' },
      { cmd: 'add_node', id: 'çocuk', label: 'çocuk' },
      { cmd: 'add_edge', from: 'çocuk', to: 'ebeveyn', relation: 'bağımlı' },
      { cmd: 'get_in_edges', id: 'ebeveyn' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[2].ok, true);
    assert.strictEqual(res[3].ok, true);
    assert.strictEqual(res[3].edges.length, 1);
    assert.strictEqual(res[3].edges[0].from, 'çocuk');
  });

  it('get_weight: ağırlık hesaplar', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'w', label: 'w' },
      { cmd: 'get_weight', id: 'w' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.ok(res[1].weight > 0);
  });

  it('ask: bilinmeyen soruya Bilmiyorum', async () => {
    const res = await rustExec([
      { cmd: 'ask', question: 'bilinmeyen nedir' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[0].answer, 'Bilmiyorum');
  });
});
