'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * closeHuqan() must clear every module-level interval server.js opens.
 *
 * unref() means a stray timer never held the process open, so nothing hung and
 * nothing failed — which is why this went unnoticed. What it did do was keep a
 * closed server mutating requestGuards' shared rateLimitMap every 60 seconds,
 * and server.js is required directly by tests, so a closed server went on
 * editing the rate-limit state of whatever ran next in the same process
 * (#1036).
 *
 * The timer handles are module-private, so they are captured by wrapping
 * setInterval for the duration of the require. An unref'd timer does not show
 * up in process.getActiveResourcesInfo(), so that route cannot see them.
 */
describe('server close (#1036)', () => {
  it('closeHuqan clears every interval server.js opened at module scope', () => {
    assert.ok(
      !require.resolve('../server') || !Object.prototype.hasOwnProperty.call(require.cache, require.resolve('../server')),
      'server.js must not be loaded before the interval spy is installed',
    );

    const opened = [];
    const cleared = new Set();
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;

    global.setInterval = (...args) => {
      const handle = realSetInterval(...args);
      opened.push(handle);
      return handle;
    };
    global.clearInterval = (handle) => {
      cleared.add(handle);
      return realClearInterval(handle);
    };

    let server;
    try {
      server = require('../server');
    } finally {
      global.setInterval = realSetInterval;
    }

    try {
      assert.strictEqual(opened.length, 2, 'server.js opens two module-level intervals');
      server.closeHuqan();
      for (const handle of opened) {
        assert.ok(cleared.has(handle), 'closeHuqan left a module-level interval running');
      }
    } finally {
      global.clearInterval = realClearInterval;
      for (const handle of opened) realClearInterval(handle);
    }
  });
});
