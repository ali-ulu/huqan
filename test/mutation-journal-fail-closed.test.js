const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const { MUTATION_JOURNAL_CORRUPT, readMutationJournal } = require('../lib/mutation-journal');

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-journal-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
function makeGraph(name) {
  const memoryPath = path.join(tempDir, `${name}-${counter++}.json`);
  // useSQLite:false selects the JSON backend, which is the one that uses the
  // mutation journal as its durable authority.
  const graph = new Graph({ memoryPath, useSQLite: false, noLoad: true });
  return { graph, memoryPath, journalPath: memoryPath.replace(/\.json$/, '.mutations.json') };
}

function expectCorrupt(fn, what) {
  assert.throws(fn, (error) => {
    assert.strictEqual(error.code, MUTATION_JOURNAL_CORRUPT, `${what}: wrong error code ${error.code}`);
    return true;
  }, what);
}

describe('mutation journal fails closed on corruption (#731)', () => {
  it('a missing journal is a legitimate empty history', () => {
    const { journalPath } = makeGraph('missing');
    assert.ok(!fs.existsSync(journalPath));
    const empty = readMutationJournal(journalPath);
    // Sections are null-prototype maps (#1671), so compare their contents
    // rather than the objects themselves -- deepStrictEqual treats a
    // prototype-less map and an object literal as different values.
    assert.deepStrictEqual(Object.keys(empty).sort(), ['chainTips', 'operations', 'receipts', 'receiptsById']);
    for (const [name, section] of Object.entries(empty)) {
      assert.strictEqual(Object.getPrototypeOf(section), null, `${name} must be prototype-free`);
      assert.deepStrictEqual(Object.keys(section), [], `${name} must be empty`);
    }
  });

  it('a truncated journal is rejected rather than read as empty', () => {
    const { journalPath } = makeGraph('truncated');
    fs.writeFileSync(journalPath, '{"operations": {"op-1": {"status": "comple');
    expectCorrupt(() => readMutationJournal(journalPath), 'truncated JSON');
  });

  it('a non-object journal is rejected', () => {
    const { journalPath } = makeGraph('non-object');
    fs.writeFileSync(journalPath, '[]');
    expectCorrupt(() => readMutationJournal(journalPath), 'array journal');
  });

  it('malformed sections are rejected rather than normalized to {}', () => {
    const cases = [
      ['operations', '{"operations": []}'],
      ['receipts', '{"receipts": "nope"}'],
      ['chainTips', '{"chainTips": 42}'],
      ['receiptsById', '{"receiptsById": []}'],
    ];
    for (const [section, body] of cases) {
      const { journalPath } = makeGraph(`section-${section}`);
      fs.writeFileSync(journalPath, body);
      expectCorrupt(() => readMutationJournal(journalPath), `${section} section`);
    }
  });

  it('malformed entries inside well-shaped sections are rejected', () => {
    const cases = [
      ['operation entry', '{"operations": {"op-1": "completed"}}'],
      ['operation status', '{"operations": {"op-1": {}}}'],
      ['receipt entry', '{"receipts": {"op-1": 5}}'],
      ['receipt fields', '{"receipts": {"op-1": {"receiptId": "r"}}}'],
      ['receipt index', '{"receiptsById": {"r-1": null}}'],
    ];
    for (const [what, body] of cases) {
      const { journalPath } = makeGraph(`entry-${what.replace(/\s+/g, '-')}`);
      fs.writeFileSync(journalPath, body);
      expectCorrupt(() => readMutationJournal(journalPath), what);
    }
  });

  it('a chain tip that is not a receipt hash is detected before append', () => {
    for (const tip of ['', 'not-a-hash', 'ABCDEF', 42, null]) {
      const { journalPath } = makeGraph('tip');
      fs.writeFileSync(journalPath, JSON.stringify({ chainTips: { 'default::memory': tip } }));
      expectCorrupt(() => readMutationJournal(journalPath), `chain tip ${JSON.stringify(tip)}`);
    }
  });

  it('a valid journal still reads back intact', () => {
    const { journalPath } = makeGraph('valid');
    const journal = {
      operations: { 'op-1': { status: 'completed', result: { ok: true }, receiptId: 'r-1' } },
      receipts: {
        'op-1': {
          receiptId: 'r-1',
          workspaceId: 'default',
          receiptHash: 'a'.repeat(64),
          canonicalPayload: { receiptId: 'r-1', workspaceId: 'default' },
        },
      },
      chainTips: { 'default::memory': 'b'.repeat(64) },
      receiptsById: { 'r-1': 'op-1' },
    };
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const read = readMutationJournal(journalPath);
    // Same contents; the sections are null-prototype maps (#1671).
    assert.deepStrictEqual(JSON.parse(JSON.stringify(read)), journal);
    for (const section of Object.values(read)) {
      assert.strictEqual(Object.getPrototypeOf(section), null);
    }
  });

  it('a corrupt journal blocks mutation instead of re-running it', () => {
    const { graph, journalPath } = makeGraph('replay');

    const first = graph.runMutationOnce('op-replay', () => {
      graph.addNode('kedi', { workspaceId: 'default' });
      return { applied: true };
    });
    assert.strictEqual(first.replayed, false);
    assert.ok(fs.existsSync(journalPath), 'journal should exist after a completed mutation');

    // The already-committed operation replays cleanly while the journal is intact.
    let ran = 0;
    const replay = graph.runMutationOnce('op-replay', () => { ran += 1; return { applied: true }; });
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(ran, 0);

    // Damage it, then retry the same operationId.
    fs.writeFileSync(journalPath, '{"operations": {"op-replay": {"stat');

    let ranAfterCorruption = 0;
    expectCorrupt(
      () => graph.runMutationOnce('op-replay', () => { ranAfterCorruption += 1; return { applied: true }; }),
      'replay after corruption',
    );
    assert.strictEqual(ranAfterCorruption, 0, 'mutation callback must not run on a corrupt journal');
  });

  it('a corrupt journal blocks a brand-new mutation too', () => {
    const { graph, journalPath } = makeGraph('new-mutation');
    graph.runMutationOnce('op-seed', () => ({ applied: true }));
    fs.writeFileSync(journalPath, 'not json at all');

    let ran = 0;
    expectCorrupt(
      () => graph.runMutationOnce('op-fresh', () => { ran += 1; return { applied: true }; }),
      'new mutation on corrupt journal',
    );
    assert.strictEqual(ran, 0);
  });

  it('receipt lookups fail closed rather than reporting "no such receipt"', () => {
    const { graph, journalPath } = makeGraph('lookup');
    graph.runMutationOnce('op-lookup', () => ({ applied: true }));
    fs.writeFileSync(journalPath, '{"receipts": 7}');

    expectCorrupt(() => graph.getCommittedMutationReceiptByOperation('op-lookup'), 'receipt by operation');
    expectCorrupt(() => graph.getCommittedMutationReceiptById('r-1'), 'receipt by id');
  });
});
