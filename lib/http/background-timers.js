'use strict';

/**
 * The module-level intervals a server opens, and the single place they are
 * cleared.
 *
 * server.js opened two intervals in the same shape and cleared only one of
 * them on shutdown. `unref()` meant the stray timer never held the process
 * open, so nothing hung and nothing failed — which is why it went unnoticed.
 * What it did do was keep a closed server mutating requestGuards' shared
 * rateLimitMap every 60 seconds, and server.js is required directly by tests,
 * so a closed server went on editing the rate-limit state of whatever ran next
 * in the same process (#1036).
 *
 * Registering a timer is what makes it cleared, so the two cannot drift apart
 * again: a timer added here is always released by clearAll(), and one that is
 * not registered is visibly not registered at its call site.
 */
function createBackgroundTimers() {
  const timers = [];
  return {
    /**
     * Registers an interval and unrefs it, so it never keeps the process alive.
     * @template T
     * @param {T} timer
     * @returns {T} the timer, so this can wrap a setInterval call inline
     */
    add(timer) {
      timer?.unref?.();
      timers.push(timer);
      return timer;
    },
    /** Clears every registered interval. Safe to call more than once. */
    clearAll() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
    /** Registered timer count, for tests. */
    get size() {
      return timers.length;
    },
  };
}

module.exports = { createBackgroundTimers };
