const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Graph = require('./graph');
const RustGraph = require('./rustGraph');

const RUST_BIN_CANDIDATES = [
  path.join(__dirname, 'huqan-core', 'target', 'release', process.platform === 'win32' ? 'huqan-core.exe' : 'huqan-core'),
  path.join(__dirname, 'huqan-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'huqan-core.exe'),
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

// Transport decoding is JS-side only: it is driven through _onData directly,
// so it runs whether or not the Rust binary is built.
describe('RustGraph - IPC transport decoding (#1030)', () => {
  function makeReader() {
    const graph = new RustGraph({ memoryPath: path.join(os.tmpdir(), 'huqan-rust-ipc-none.json') });
    const replies = [];
    graph._unrefIfIdle = () => {};
    return { graph, replies };
  }

  it('a multi-byte character split across chunks decodes intact', () => {
    // stdout has no setEncoding(), so chunks are Buffers and `+= chunk.toString()`
    // decoded each on its own. The corruption lands inside a JSON string value,
    // so the line still parses and `_reqId` still matches — the mangled answer
    // reached the caller as an ordinary result.
    const { graph, replies } = makeReader();
    graph._pending.set(1, reply => replies.push(reply));

    const line = '{"_reqId":1,"answer":"kedi bir hayvandır"}\n';
    const bytes = Buffer.from(line, 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('ı', 'utf8')) + 1;

    graph._onData(bytes.subarray(0, splitAt));
    graph._onData(bytes.subarray(splitAt));

    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].answer, 'kedi bir hayvandır');
    assert.ok(!replies[0].answer.includes('\uFFFD'), 'no replacement characters');
  });

  it('survives a byte-at-a-time stream of Turkish text', () => {
    const { graph, replies } = makeReader();
    graph._pending.set(7, reply => replies.push(reply));

    const answer = 'ğüşiöçĞÜŞİÖÇ'.repeat(40);
    const bytes = Buffer.from(`${JSON.stringify({ _reqId: 7, answer })}\n`, 'utf8');
    for (const byte of bytes) graph._onData(Buffer.from([byte]));

    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].answer, answer);
  });

  it('delivers several replies arriving in one chunk', () => {
    const { graph } = makeReader();
    const seen = [];
    graph._pending.set(1, reply => seen.push(reply.answer));
    graph._pending.set(2, reply => seen.push(reply.answer));

    graph._onData(Buffer.from(
      '{"_reqId":1,"answer":"birinci"}\n{"_reqId":2,"answer":"ikinci"}\n',
      'utf8',
    ));

    assert.deepStrictEqual(seen, ['birinci', 'ikinci']);
  });

  it('bounds the buffer by bytes, and only the unconsumed remainder counts', () => {
    // RUST_MAX_LINE_BYTES was compared against String.length (UTF-16 code
    // units), so the constant's name did not describe the check.
    const { graph } = makeReader();
    let rejected = null;
    graph._pending.set(1, reply => { rejected = reply; });

    // A newline-less flood must still trip the guard.
    const megabyte = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 11 && !rejected; i += 1) graph._onData(megabyte);

    assert.ok(rejected, 'the overflow guard must fire');
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.error, 'buffer_overflow');
    assert.strictEqual(graph._buf, '');
    assert.strictEqual(graph._bufBytes, 0);
  });

  it('a long but complete stream never trips the guard', () => {
    // Completed lines leave the buffer, so their bytes must stop counting --
    // otherwise a long-lived process would eventually reject a healthy reply.
    const { graph } = makeReader();
    const seen = [];
    let rejected = false;

    for (let i = 0; i < 200; i += 1) {
      graph._pending.set(i, reply => {
        if (reply.ok === false) rejected = true;
        else seen.push(reply.answer);
      });
      const answer = 'ğüşiöç'.repeat(2000);
      graph._onData(Buffer.from(`${JSON.stringify({ _reqId: i, answer })}\n`, 'utf8'));
    }

    assert.strictEqual(rejected, false, 'a healthy stream must not overflow');
    assert.strictEqual(seen.length, 200);
    assert.ok(graph._bufBytes < 1024, 'only the remainder counts');
  });
});

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

  it('batch: birden fazla komutu tek seferde çalıştırır', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'toplu1', label: 'toplu1' },
      {
        cmd: 'batch',
        commands: [
          { cmd: 'add_node', id: 'toplu2', label: 'toplu2' },
          { cmd: 'add_edge', from: 'toplu1', to: 'toplu2', relation: 'tür' },
          { cmd: 'get_edges', id: 'toplu1' },
        ],
      },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(res[1].results.length, 3);
    assert.strictEqual(res[1].results[0].ok, true);
    assert.strictEqual(res[1].results[1].ok, true);
    assert.strictEqual(res[1].results[2].edges.length, 1);
  });

  it('save + load: kalıcılık aynı süreç dışında korunur', async () => {
    const tmpPath = path.join(__dirname, `.rustgraph-test-${Date.now()}.json`);
    try {
      const saveRes = await rustExec([
        { cmd: 'add_node', id: 'kalici', label: 'kalici' },
        { cmd: 'add_node', id: 'hedef', label: 'hedef' },
        { cmd: 'add_edge', from: 'kalici', to: 'hedef', relation: 'tür' },
        { cmd: 'save', path: tmpPath },
      ]);
      assert.strictEqual(saveRes[3].ok, true);
      assert.ok(fs.existsSync(tmpPath));

      const loadRes = await rustExec([
        { cmd: 'load', path: tmpPath },
        { cmd: 'stats' },
        { cmd: 'get_edges', id: 'kalici' },
      ]);
      assert.strictEqual(loadRes[0].ok, true);
      assert.strictEqual(loadRes[1].stats.nodes, 2);
      assert.strictEqual(loadRes[1].stats.edges, 1);
      assert.strictEqual(loadRes[2].edges[0].to, 'hedef');
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });
});

// The suite above is skipped whenever the Rust binary is missing, which is the
// case in CI and in a plain `npm install` checkout. That is exactly when the JS
// fallback carries every RustGraph call, so it needs its own coverage.
describe('RustGraph - JS fallback (Rust binary yok)', { skip: hasRust }, () => {

  it('aynı instance üzerinde ardışık çağrılar state korur', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-fallback-'));
    const bridge = new RustGraph({ memoryPath: path.join(dir, 'memory.json') });
    try {
      for (const id of ['entry.js', 'middle.js', 'leaf.js']) {
        assert.ok(await bridge.addNode(id, id), `addNode ${id} düğüm döndürmeli`);
      }
      assert.ok(await bridge.addEdge('entry.js', 'middle.js', 'requires'));
      assert.ok(await bridge.addEdge('middle.js', 'leaf.js', 'requires'));

      const before = await bridge.getStats();
      assert.strictEqual(Number(before.nodes), 3);
      assert.strictEqual(Number(before.edges), 2);

      // Bir sonraki kenar, önceki çağrılarda eklenen düğümlere bağlı: fallback
      // her _send()'te yeniden kurulursa Graph.addEdge null döner.
      assert.ok(
        await bridge.addEdge('entry.js', 'leaf.js', 'requires'),
        'candidate edge reddedilmemeli',
      );

      const after = await bridge.getStats();
      assert.strictEqual(Number(after.nodes), 3);
      assert.strictEqual(Number(after.edges), 3);
    } finally {
      if (bridge._fallback && typeof bridge._fallback.close === 'function') bridge._fallback.close();
      bridge.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fallback Graph tek sefer kurulur', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-fallback-'));
    const bridge = new RustGraph({ memoryPath: path.join(dir, 'memory.json') });
    try {
      await bridge.addNode('a', 'a');
      const first = bridge._fallback;
      assert.ok(first instanceof Graph);
      await bridge.addNode('b', 'b');
      await bridge.getStats();
      assert.strictEqual(bridge._fallback, first, 'fallback instance değişmemeli');
    } finally {
      if (bridge._fallback && typeof bridge._fallback.close === 'function') bridge._fallback.close();
      bridge.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
