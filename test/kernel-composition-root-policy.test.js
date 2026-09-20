'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCompositionRoot,
  snapshot,
} = require('../scripts/architecture-snapshot');

test('kernel.js is an explicit composition root for runtime assembly (#2127)', () => {
  assert.equal(isCompositionRoot('kernel.js'), true);

  const kernel = snapshot().find((row) => row.file === 'kernel.js');
  assert.ok(kernel, 'kernel.js must remain visible in the architecture snapshot');
  assert.equal(kernel.signals.includes('DIP'), false, 'composition-root construction must not be reported as DIP');
  assert.ok(kernel.signals.some((signal) => signal.startsWith('FANOUT:')), 'remaining fan-out debt must stay visible');
});

test('ordinary domain modules are not made composition roots by the Kernel exemption', () => {
  assert.equal(isCompositionRoot('lib/verify.js'), false);
  assert.equal(isCompositionRoot('lib/memory-store.js'), false);
});
