const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseJson, listJsonFiles, ingestJson, ingestAndLearn } = require('./json-adapter');

test('json-adapter: parseJson splits an object by top-level keys', () => {
  const entries = parseJson(
    JSON.stringify({ title: 'A claim', scope: { a: 1 }, details: 'text' }),
    'C:/tmp/spec.json'
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[0].entryKey, 'title');
  assert.equal(entries[1].entryKey, 'scope');
  assert.equal(entries[2].entryKey, 'details');
  assert.equal(entries.every(item => typeof item.sourceRef === 'string'), true);
});

test('json-adapter: parseJson splits an array by index and handles a scalar root', () => {
  const arrayEntries = parseJson(JSON.stringify(['a', 'b']), '/tmp/list.json');
  assert.equal(arrayEntries.length, 2);
  assert.equal(arrayEntries[0].entryKey, '[0]');
  assert.equal(arrayEntries[1].entryKey, '[1]');

  const scalarEntries = parseJson(JSON.stringify('just a string'), '/tmp/scalar.json');
  assert.equal(scalarEntries.length, 1);
  assert.equal(scalarEntries[0].entryKey, 'root');
});

test('json-adapter: parseJson throws on malformed JSON', () => {
  assert.throws(() => parseJson('{not valid json', '/tmp/broken.json'));
});

test('json-adapter: listJsonFiles and ingestJson work recursively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-'));
  const nested = path.join(dir, 'config');
  fs.mkdirSync(nested, { recursive: true });
  const f1 = path.join(dir, 'root.json');
  const f2 = path.join(nested, 'sub.json');
  const f3 = path.join(nested, 'ignore.txt');
  fs.writeFileSync(f1, JSON.stringify({ a: 'root value' }), 'utf8');
  fs.writeFileSync(f2, JSON.stringify({ b: 'sub value' }), 'utf8');
  fs.writeFileSync(f3, 'not json', 'utf8');

  const files = listJsonFiles(dir, { rootPath: dir });
  const result = ingestJson(dir, { rootPath: dir });

  try {
    assert.equal(files.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.entries.length, 2);
    assert.equal(result.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('json-adapter: ingestJson reports parse errors without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-err-'));
  const bad = path.join(dir, 'broken.json');
  fs.writeFileSync(bad, '{not valid', 'utf8');

  try {
    const result = ingestJson(dir, { rootPath: dir });
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].filePath, bad);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('json-adapter: rejects traversal and absolute paths outside root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-outside-'));
  const inside = path.join(dir, 'inside.json');
  const outside = path.join(outsideDir, 'outside.json');
  fs.writeFileSync(inside, JSON.stringify({ a: 'safe' }), 'utf8');
  fs.writeFileSync(outside, JSON.stringify({ a: 'secret' }), 'utf8');

  try {
    assert.deepEqual(listJsonFiles(inside, { rootPath: dir }), [path.resolve(inside)]);
    assert.throws(
      () => listJsonFiles(path.join(dir, '..', path.basename(outside)), { rootPath: dir }),
      /allowed root/i
    );
    assert.throws(
      () => listJsonFiles(outside, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('json-adapter: rejects symlink escape when supported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-link-out-'));
  const outside = path.join(outsideDir, 'escape.json');
  const linkPath = path.join(dir, 'escape.json');
  fs.writeFileSync(outside, JSON.stringify({ a: 'secret' }), 'utf8');

  try {
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      return;
    }
    assert.throws(
      () => listJsonFiles(linkPath, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('json-adapter: ingestAndLearn forwards provenance per entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-json-learn-'));
  const file = path.join(dir, 'note.json');
  const calls = [];
  fs.writeFileSync(file, JSON.stringify({ claim: 'A bounded claim' }), 'utf8');

  try {
    const result = ingestAndLearn(file, {
      learn(text, opts) {
        calls.push({ text, opts });
        return {
          data: { learned: 1 },
          receipt: { receiptId: 'delegated-receipt' },
        };
      },
    }, {
      rootPath: dir,
      actor: 'json-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'json');
    assert.equal(calls[0].opts.provenance.source, 'json-adapter');
    assert.equal(calls[0].opts.provenance.sourceType, 'json');
    assert.equal(calls[0].opts.provenance.actor, 'json-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^json-\d+-[a-z0-9]{6}$/);
    assert.match(calls[0].opts.provenance.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
