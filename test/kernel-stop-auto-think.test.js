'use strict';

// stopAutoThink() is safe to call when auto-think never started: it clears
// nothing, keeps the timer slot empty and still logs the stop.

const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');

function receiver(timer) {
  const logs = [];
  return { self: { _thinkTimer: timer, _autoThinkLog: (message) => logs.push(message) }, logs };
}

test('stopAutoThink without a running timer only logs the stop', () => {
  const { self, logs } = receiver(null);
  Kernel.prototype.stopAutoThink.call(self);
  assert.equal(self._thinkTimer, null);
  assert.deepEqual(logs, ['AutoThink durduruldu']);
});

test('stopAutoThink clears a running timer', (t) => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 60_000);
  t.after(() => clearInterval(timer));
  const { self, logs } = receiver(timer);
  Kernel.prototype.stopAutoThink.call(self);
  assert.equal(self._thinkTimer, null);
  assert.deepEqual(logs, ['AutoThink durduruldu']);
  assert.equal(ticks, 0);
});
