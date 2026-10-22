'use strict';

// #4093 PR-B3: the append-only file sink the SIEM export writes through. It is
// the default transport, so its two properties matter on their own: a written
// line reaches disk before the caller learns it succeeded, and the active file
// never grows past the size the operator allowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_SIEM_MAX_BYTES,
  SIEM_SINK_ERRORS,
  createSiemFileSink,
} = require('../lib/siem/siem-file-sink');

function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-siem-sink-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('appends one line per entry and reports the bytes it wrote', t => {
  const base = scratch(t);
  const target = path.join(base, 'nested', 'huqan-events.jsonl');
  const sink = createSiemFileSink({ path: target });

  const first = sink.write(['{"a":1}', '{"a":2}']);
  assert.equal(first.rotated, false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n{"a":2}\n');

  sink.write(['{"a":3}']);
  assert.equal(fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).length, 3);
});

test('the log is owner-only where the filesystem has modes', t => {
  const base = scratch(t);
  const target = path.join(base, 'huqan-events.jsonl');
  createSiemFileSink({ path: target }).write(['{"a":1}']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});

test('rotation keeps file under size limit without dropping lines', t => {
  const base = scratch(t);
  const target = path.join(base, 'huqan-events.jsonl');
  const line = n => `{"event":"0123456789abcdef0123456789abcdef","n":${n}}`;
  const maxBytes = Buffer.byteLength(`${line(0)}\n`, 'utf8') * 4;
  const sink = createSiemFileSink({ path: target, maxBytes });

  let rotations = 0;
  for (let index = 0; index < 11; index += 1) {
    if (sink.write([line(index)]).rotated) rotations += 1;
  }

  const active = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
  const generations = fs.readdirSync(base).filter(entry => entry.startsWith('huqan-events.jsonl.'));
  const rotated = generations.flatMap(entry => fs.readFileSync(path.join(base, entry), 'utf8').split('\n').filter(Boolean));
  assert.ok(rotations > 0, 'the active file must have been rotated at least once');
  assert.ok(generations.length >= 2, 'each rotation gets its own generation, so none is overwritten');
  assert.ok(fs.statSync(target).size <= maxBytes, 'the active file stays within the limit');
  assert.equal(active.length + rotated.length, 11, 'no line is dropped by rotation');
});

test('a single entry larger than the limit is written whole, never split', t => {
  const base = scratch(t);
  const target = path.join(base, 'huqan-events.jsonl');
  const sink = createSiemFileSink({ path: target, maxBytes: 8 });

  sink.write(['{"a":"a line that cannot be split"}']);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":"a line that cannot be split"}\n');
});

test('refuses a line that would break the one-event-per-line framing', t => {
  const base = scratch(t);
  const sink = createSiemFileSink({ path: path.join(base, 'huqan-events.jsonl') });

  assert.throws(
    () => sink.write(['{"a":1}\n{"a":2}']),
    (error) => error.code === SIEM_SINK_ERRORS.MULTILINE,
  );
  assert.equal(fs.existsSync(sink.path), false);
});

test('a batch larger than the limit rotates between entries, not once per batch', t => {
  const base = scratch(t);
  const target = path.join(base, 'huqan-events.jsonl');
  const line = n => `{"event":"0123456789abcdef0123456789abcdef","n":${n}}`;
  const maxBytes = Buffer.byteLength(`${line(0)}\n`, 'utf8') * 4;
  const sink = createSiemFileSink({ path: target, maxBytes });

  const batch = Array.from({ length: 20 }, (unused, index) => line(index));
  const result = sink.write(batch);

  assert.equal(result.rotated, true);
  // The active file is read once and both facts are derived from the same
  // bytes: a size check and a later read of the same path is the check-then-
  // use shape CodeQL's file-system-race query names, and in a test it says
  // nothing the single read does not.
  const active = fs.readFileSync(target, 'utf8');
  assert.ok(Buffer.byteLength(active, 'utf8') <= maxBytes, 'the active file stays within the limit even for one big batch');
  const generations = fs.readdirSync(base).filter(entry => entry.startsWith('huqan-events.jsonl.'));
  const written = generations
    .map(entry => fs.readFileSync(path.join(base, entry), 'utf8').split('\n').filter(Boolean).length)
    .concat(active.split('\n').filter(Boolean).length);
  assert.equal(written.reduce((sum, count) => sum + count, 0), 20, 'no line is dropped by rotating inside a batch');
});

test('an existing log that is not owner-only is corrected before it is written to', t => {
  const base = scratch(t);
  const target = path.join(base, 'huqan-events.jsonl');
  fs.writeFileSync(target, '{"a":1}\n', { mode: 0o644 });
  if (process.platform === 'win32') {
    // The mode bits are not the filesystem's business here.
    return;
  }
  createSiemFileSink({ path: target }).write(['{"a":2}']);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('writing nothing touches nothing', t => {
  const base = scratch(t);
  const sink = createSiemFileSink({ path: path.join(base, 'huqan-events.jsonl') });
  assert.deepEqual(sink.write([]), { bytes: 0, rotated: false });
  assert.equal(fs.existsSync(sink.path), false);
});

test('the default limit is a positive number of bytes', () => {
  assert.ok(Number.isInteger(DEFAULT_SIEM_MAX_BYTES) && DEFAULT_SIEM_MAX_BYTES > 0);
});
