const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { parseYaml, listYamlFiles, ingestYaml, ingestAndLearn } = require('./yaml-adapter');

test('yaml-adapter: parseYaml splits an object by top-level keys', () => {
  const entries = parseYaml(
    yaml.dump({ title: 'A claim', scope: { a: 1 }, details: 'text' }),
    'C:/tmp/spec.yaml'
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[0].entryKey, 'title');
  assert.equal(entries[1].entryKey, 'scope');
  assert.equal(entries[2].entryKey, 'details');
  assert.equal(entries.every(item => typeof item.sourceRef === 'string'), true);
});

test('yaml-adapter: parseYaml splits a sequence by index and handles a scalar root', () => {
  const arrayEntries = parseYaml(yaml.dump(['a', 'b']), '/tmp/list.yaml');
  assert.equal(arrayEntries.length, 2);
  assert.equal(arrayEntries[0].entryKey, '[0]');
  assert.equal(arrayEntries[1].entryKey, '[1]');

  const scalarEntries = parseYaml(yaml.dump('just a string'), '/tmp/scalar.yaml');
  assert.equal(scalarEntries.length, 1);
  assert.equal(scalarEntries[0].entryKey, 'root');
});

test('yaml-adapter: parseYaml throws on malformed YAML', () => {
  assert.throws(() => parseYaml('key: [unclosed', '/tmp/broken.yaml'));
});

test('yaml-adapter: parseYaml never executes custom !!js/* tags', () => {
  // js-yaml's default schema (used by yaml.load) has no !!js/function or
  // !!js/undefined constructors, so this either throws or yields the tag
  // as an unresolved value -- it must not execute anything.
  assert.throws(() => parseYaml('exploit: !!js/function "function(){return 1}"', '/tmp/exploit.yaml'));
});

test('yaml-adapter: rejects aliases before parsing and bounds depth/output', () => {
  const aliasBomb = [
    'base: &base [one, two, three]',
    'expanded: [*base, *base, *base]',
  ].join('\n');
  assert.throws(
    () => parseYaml(aliasBomb, '/tmp/alias.yaml'),
    (error) => error?.code === 'YAML_ALIAS_FORBIDDEN',
  );

  assert.throws(
    () => parseYaml('a:\n  b:\n    c: value', '/tmp/deep.yaml', { maxValueDepth: 1 }),
    (error) => error?.code === 'YAML_VALUE_DEPTH_LIMIT',
  );
  assert.throws(
    () => parseYaml('claim: a-long-value', '/tmp/output.yaml', { maxOutputBytesPerEntry: 4 }),
    (error) => error?.code === 'YAML_ENTRY_OUTPUT_BYTES_LIMIT',
  );
});

test('yaml-adapter: aggregate budget failure is atomic before learning', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-yaml-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'a: alpha\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.yaml'), 'b: beta\n', 'utf8');
  let learnCalls = 0;

  assert.throws(
    () => ingestAndLearn(dir, { learn() { learnCalls += 1; } }, {
      rootPath: dir,
      maxTotalOutputBytes: 8,
    }),
    (error) => error?.code === 'YAML_TOTAL_OUTPUT_BYTES_LIMIT',
  );
  assert.equal(learnCalls, 0);
});

test('yaml-adapter: pre-read file byte budget rejects the batch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-yaml-bytes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'large.yaml'), 'claim: too-large\n', 'utf8');

  assert.throws(
    () => ingestYaml(dir, { rootPath: dir, maxFileBytes: 4 }),
    (error) => error?.code === 'YAML_FILE_BYTES_LIMIT',
  );
});

test('yaml-adapter: listYamlFiles and ingestYaml work recursively across .yaml and .yml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-'));
  const nested = path.join(dir, 'config');
  fs.mkdirSync(nested, { recursive: true });
  const f1 = path.join(dir, 'root.yaml');
  const f2 = path.join(nested, 'sub.yml');
  const f3 = path.join(nested, 'ignore.txt');
  fs.writeFileSync(f1, yaml.dump({ a: 'root value' }), 'utf8');
  fs.writeFileSync(f2, yaml.dump({ b: 'sub value' }), 'utf8');
  fs.writeFileSync(f3, 'not yaml', 'utf8');

  const files = listYamlFiles(dir, { rootPath: dir });
  const result = ingestYaml(dir, { rootPath: dir });

  try {
    assert.equal(files.length, 2);
    assert.equal(result.files.length, 2);
    assert.equal(result.entries.length, 2);
    assert.equal(result.errors.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yaml-adapter: ingestYaml reports parse errors without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-err-'));
  const bad = path.join(dir, 'broken.yaml');
  fs.writeFileSync(bad, 'key: [unclosed', 'utf8');

  try {
    const result = ingestYaml(dir, { rootPath: dir });
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].filePath, bad);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yaml-adapter: rejects traversal and absolute paths outside root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-root-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-outside-'));
  const inside = path.join(dir, 'inside.yaml');
  const outside = path.join(outsideDir, 'outside.yaml');
  fs.writeFileSync(inside, yaml.dump({ a: 'safe' }), 'utf8');
  fs.writeFileSync(outside, yaml.dump({ a: 'secret' }), 'utf8');

  try {
    assert.deepEqual(listYamlFiles(inside, { rootPath: dir }), [path.resolve(inside)]);
    assert.throws(
      () => listYamlFiles(path.join(dir, '..', path.basename(outside)), { rootPath: dir }),
      /allowed root/i
    );
    assert.throws(
      () => listYamlFiles(outside, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('yaml-adapter: rejects symlink escape when supported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-link-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-link-out-'));
  const outside = path.join(outsideDir, 'escape.yaml');
  const linkPath = path.join(dir, 'escape.yaml');
  fs.writeFileSync(outside, yaml.dump({ a: 'secret' }), 'utf8');

  try {
    try {
      fs.symlinkSync(outside, linkPath);
    } catch (err) {
      return;
    }
    assert.throws(
      () => listYamlFiles(linkPath, { rootPath: dir }),
      /allowed root/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('yaml-adapter: ingestAndLearn forwards provenance per entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-yaml-learn-'));
  const file = path.join(dir, 'note.yaml');
  const calls = [];
  fs.writeFileSync(file, yaml.dump({ claim: 'A bounded claim' }), 'utf8');

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
      actor: 'yaml-test',
    });

    assert.equal(result.learned.length, 1);
    assert.equal(result.learned[0].ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.sourceType, 'document');
    assert.equal(calls[0].opts.sourceSubType, 'yaml');
    assert.equal(calls[0].opts.provenance.source, 'yaml-adapter');
    assert.equal(calls[0].opts.provenance.sourceType, 'document');
    assert.equal(calls[0].opts.provenance.sourceSubType, 'yaml');
    assert.equal(calls[0].opts.provenance.actor, 'yaml-test');
    assert.match(calls[0].opts.provenance.provenanceId, /^yaml-\d+-[a-z0-9]{6}$/);
    assert.match(calls[0].opts.provenance.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(calls[0].opts.provenance.sourceRef, calls[0].opts.sourceRef);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
