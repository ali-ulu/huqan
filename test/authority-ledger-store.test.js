'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openLedgerStore, LEDGER_GENESIS, MAX_PAGE } = require('../lib/authority/ledger-store');

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ledger-'));
  return { dir, file: path.join(dir, 'ledger.jsonl'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('appended entries are hash-linked, numbered and survive a reopen', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const ledger = openLedgerStore({ file });
  const first = ledger.append('approval.registered', { approvalId: 'a' }, '2026-10-12T12:00:00.000Z');
  const second = ledger.append('approval.decided', { approvalId: 'a' }, '2026-10-12T12:01:00.000Z');
  assert.equal(first.seq, 0);
  assert.equal(first.previousReceiptHash, LEDGER_GENESIS);
  assert.equal(second.seq, 1);
  assert.equal(second.previousReceiptHash, first.receiptHash);
  const reopened = openLedgerStore({ file });
  assert.equal(reopened.corrupt, null);
  assert.deepEqual(reopened.entries(), [first, second]);
  assert.deepEqual(reopened.head(), { seq: 1, hash: second.receiptHash });
});

test('an edited byte makes the reopened ledger corrupt and refuse appends', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const ledger = openLedgerStore({ file });
  ledger.append('approval.registered', { approvalId: 'a' }, '2026-10-12T12:00:00.000Z');
  ledger.append('approval.decided', { approvalId: 'a', decision: 'rejected' }, '2026-10-12T12:01:00.000Z');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('rejected', 'approved'));
  const reopened = openLedgerStore({ file });
  assert.deepEqual(reopened.corrupt, { brokenAt: 1, reason: 'content_tampered' });
  assert.throws(() => reopened.append('approval.consumed', { approvalId: 'a' }, '2026-10-12T12:02:00.000Z'), /corrupt/);
  assert.equal(reopened.entries().length, 2, 'reads still serve the entries for an audit');
});

test('a deleted line or a torn final write is detected, not silently skipped', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const ledger = openLedgerStore({ file });
  for (let i = 0; i < 3; i += 1) ledger.append('approval.registered', { approvalId: `a${i}` }, '2026-10-12T12:00:00.000Z');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  fs.writeFileSync(file, [lines[0], lines[2], ''].join('\n'));
  assert.equal(openLedgerStore({ file }).corrupt.reason, 'chain_link_broken');
  fs.writeFileSync(file, `${lines[0]}\n${lines[1].slice(0, 20)}`);
  assert.equal(openLedgerStore({ file }).corrupt.reason, 'unparseable_line');
});

test('entries pages from a sequence number with a bounded limit', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const ledger = openLedgerStore({ file });
  for (let i = 0; i < 5; i += 1) ledger.append('approval.registered', { approvalId: `a${i}` }, '2026-10-12T12:00:00.000Z');
  assert.deepEqual(ledger.entries({ fromSeq: 2, limit: 2 }).map(entry => entry.seq), [2, 3]);
  assert.deepEqual(ledger.entries({ fromSeq: 4, limit: 100 }).map(entry => entry.seq), [4]);
  assert.deepEqual(openLedgerStore({ file: path.join(path.dirname(file), 'none.jsonl') }).head(), { seq: -1, hash: LEDGER_GENESIS });
});

test('a failed append poisons the store instead of chaining after a torn line', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  let failNext = false;
  const io = { ...fs, writeSync: (...args) => {
    if (failNext) {
      fs.writeSync(args[0], Buffer.from('{"seq":1,"ty'));
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    }
    return fs.writeSync(...args);
  } };
  const ledger = openLedgerStore({ file, io });
  ledger.append('approval.registered', { approvalId: 'a' }, '2026-10-12T12:00:00.000Z');
  failNext = true;
  assert.throws(() => ledger.append('approval.decided', { approvalId: 'a' }, '2026-10-12T12:01:00.000Z'), /no space/);
  failNext = false;
  assert.deepEqual(ledger.corrupt, { brokenAt: 1, reason: 'append_failed' });
  assert.throws(() => ledger.append('approval.decided', { approvalId: 'a' }, '2026-10-12T12:02:00.000Z'), /corrupt/);
  assert.equal(ledger.entries().length, 1);
});

test('a short write is completed rather than leaving half a line', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const io = { ...fs, writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(length, 7)) };
  openLedgerStore({ file, io }).append('approval.registered', { approvalId: 'a' }, '2026-10-12T12:00:00.000Z');
  assert.equal(openLedgerStore({ file }).corrupt, null);
});

test('all() returns every entry past the page size, for the service rebuild', (t) => {
  const { file, cleanup } = tempLedger();
  t.after(cleanup);
  const ledger = openLedgerStore({ file });
  for (let i = 0; i < MAX_PAGE + 3; i += 1) ledger.append('approval.registered', { approvalId: `a${i}` }, '2026-10-12T12:00:00.000Z');
  const reopened = openLedgerStore({ file });
  assert.equal(reopened.all().length, MAX_PAGE + 3);
  assert.equal(reopened.entries({ limit: Number.MAX_SAFE_INTEGER }).length, MAX_PAGE);
});
