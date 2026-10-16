'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createSessionStore } = require('../lib/viewer/session-store');

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (amount) => { value += amount; },
  };
}

describe('V4-UI-0A viewer session store', () => {
  it('creates unique opaque 32-byte base64url session identifiers', () => {
    const store = createSessionStore({ maxSessions: 1_001 });
    const ids = new Set();
    for (let index = 0; index < 1_000; index += 1) {
      const { sessionId } = store.create();
      assert.match(sessionId, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(sessionId, 'base64url').length, 32);
      ids.add(sessionId);
    }
    assert.equal(ids.size, 1_000);
  });

  it('stores only lifecycle timestamps and returns bounded metadata', () => {
    const timer = clock(10);
    const store = createSessionStore({ now: timer.now });
    const created = store.create();
    assert.deepEqual(created, {
      sessionId: created.sessionId,
      expiresAt: 28_800_010,
      maxAgeSeconds: 28_800,
      // Defense in depth (#404): the workspace declared at login is bound to
      // the session so a later request can't read a different workspace's
      // receipt just by changing a query param.
      workspaceId: 'default',
    });
    assert.deepEqual(store.validate(created.sessionId), {
      ok: true,
      createdAt: 10,
      lastSeenAt: 10,
      expiresAt: 28_800_010,
      workspaceId: 'default',
    });
  });

  it('fails closed for missing, malformed, and unknown identifiers', () => {
    const store = createSessionStore();
    assert.deepEqual(store.validate(''), { ok: false, reason: 'missing' });
    assert.deepEqual(store.validate(null), { ok: false, reason: 'missing' });
    assert.deepEqual(store.validate('short'), { ok: false, reason: 'unknown' });
    assert.deepEqual(store.validate('A'.repeat(43)), { ok: false, reason: 'unknown' });
  });

  it('refreshes idle activity without extending absolute expiry', () => {
    const timer = clock();
    const store = createSessionStore({
      now: timer.now,
      idleTtlMs: 100,
      absoluteTtlMs: 250,
    });
    const { sessionId } = store.create();

    timer.advance(90);
    assert.equal(store.validate(sessionId).ok, true);
    timer.advance(90);
    assert.equal(store.validate(sessionId).ok, true);
    timer.advance(70);
    assert.deepEqual(store.validate(sessionId), { ok: false, reason: 'absolute_expired' });
  });

  it('expires an idle session at the exact idle boundary', () => {
    const timer = clock();
    const store = createSessionStore({ now: timer.now, idleTtlMs: 100 });
    const { sessionId } = store.create();
    timer.advance(100);
    assert.deepEqual(store.validate(sessionId), { ok: false, reason: 'idle_expired' });
  });

  it('fails closed and removes a session when the clock moves backwards', () => {
    const timer = clock(100);
    const store = createSessionStore({ now: timer.now });
    const { sessionId } = store.create();
    timer.advance(-1);
    assert.deepEqual(store.validate(sessionId), { ok: false, reason: 'clock_skew' });
    assert.equal(store.size(), 0);
  });

  it('destroys one session idempotently and reset invalidates all sessions', () => {
    const store = createSessionStore();
    const first = store.create().sessionId;
    const second = store.create().sessionId;
    assert.equal(store.destroy(first), true);
    assert.equal(store.destroy(first), false);
    assert.deepEqual(store.validate(first), { ok: false, reason: 'unknown' });
    store.reset();
    assert.equal(store.size(), 0);
    assert.deepEqual(store.validate(second), { ok: false, reason: 'unknown' });
  });

  it('sweeps expired sessions before evicting a live session', () => {
    const timer = clock();
    const store = createSessionStore({ now: timer.now, maxSessions: 2, idleTtlMs: 10 });
    const expired = store.create().sessionId;
    timer.advance(9);
    const live = store.create().sessionId;
    timer.advance(1);
    const added = store.create().sessionId;
    assert.equal(store.size(), 2);
    assert.deepEqual(store.validate(expired), { ok: false, reason: 'unknown' });
    assert.equal(store.validate(live).ok, true);
    assert.equal(store.validate(added).ok, true);
  });

  it('evicts the least recently seen live session when the store is full', () => {
    const timer = clock();
    const store = createSessionStore({ now: timer.now, maxSessions: 2 });
    const first = store.create().sessionId;
    timer.advance(1);
    const second = store.create().sessionId;
    timer.advance(1);
    assert.equal(store.validate(first).ok, true);
    timer.advance(1);
    const third = store.create().sessionId;
    assert.equal(store.size(), 2);
    assert.equal(store.validate(first).ok, true);
    assert.deepEqual(store.validate(second), { ok: false, reason: 'unknown' });
    assert.equal(store.validate(third).ok, true);
  });

  it('bounds random-id retries and rejects an invalid random source', () => {
    const repeated = Buffer.alloc(32, 1);
    const store = createSessionStore({ randomBytes: () => repeated });
    store.create();
    assert.throws(() => store.create(), /unique session id/);
    assert.throws(
      () => createSessionStore({ randomBytes: () => Buffer.alloc(4) }).create(),
      /32 bytes/,
    );
  });

  it('sweeps expired sessions and reports the removal count', () => {
    const timer = clock();
    const store = createSessionStore({ now: timer.now, idleTtlMs: 10 });
    store.create();
    store.create();
    timer.advance(10);
    assert.equal(store.sweep(), 2);
    assert.equal(store.size(), 0);
  });

  it('rejects invalid bounded configuration', () => {
    assert.throws(() => createSessionStore({ idleTtlMs: 0 }), /idleTtlMs/);
    assert.throws(() => createSessionStore({ absoluteTtlMs: -1 }), /absoluteTtlMs/);
    assert.throws(() => createSessionStore({ maxSessions: 0 }), /maxSessions/);
  });
});
