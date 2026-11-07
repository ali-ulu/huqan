const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  MIN_NAPI_VERSION,
  MIN_NODE_VERSION,
  assertSupportedNodeRuntime,
  describeUnsupportedNodeRuntime,
} = require('../lib/node-runtime-guard');

describe('lib/node-runtime-guard (#4532)', () => {
  it('accepts the runtimes from the issue matrix that work (napi >= 10)', () => {
    for (const [node, napi] of [['v22.14.0', '10'], ['v22.20.0', '10'], ['v24.21.0', '10']]) {
      assert.strictEqual(describeUnsupportedNodeRuntime({ nodeVersion: node, napiVersion: napi }), null);
    }
  });

  it('rejects the runtimes from the issue matrix that segfault (napi 9)', () => {
    // Node 20.18.1 and 22.13.0 both report napi=9 and crash new Database().
    for (const node of ['v20.18.1', 'v22.13.0']) {
      const reason = describeUnsupportedNodeRuntime({ nodeVersion: node, napiVersion: '9' });
      assert.ok(typeof reason === 'string' && reason.length > 0, `expected a reason for ${node}`);
      assert.match(reason, /NAPI/);
      assert.ok(reason.includes(MIN_NODE_VERSION), `expected the reason for ${node} to name ${MIN_NODE_VERSION}`);
    }
  });

  it('fails closed when the runtime cannot be identified', () => {
    assert.ok(describeUnsupportedNodeRuntime({ nodeVersion: 'bogus', napiVersion: '10' }));
    assert.ok(describeUnsupportedNodeRuntime({ nodeVersion: 'v22.14.0', napiVersion: undefined }));
    assert.ok(describeUnsupportedNodeRuntime({ nodeVersion: undefined, napiVersion: '10' }));
  });

  it('treats a version below the documented floor as unsupported even with napi 10', () => {
    const reason = describeUnsupportedNodeRuntime({ nodeVersion: 'v22.13.0', napiVersion: '10' });
    assert.ok(typeof reason === 'string');
  });

  it('assertSupportedNodeRuntime throws HUQAN_NODE_UNSUPPORTED with the reason', () => {
    assert.throws(
      () => assertSupportedNodeRuntime({ node: 'v22.13.0', napi: '9' }),
      error => error.code === 'HUQAN_NODE_UNSUPPORTED' && /NAPI/.test(error.message),
    );
    // A supported runtime does not throw.
    assert.doesNotThrow(() => assertSupportedNodeRuntime({ node: process.version, napi: process.versions.napi }));
  });

  it('does not reject the current test runtime', () => {
    assert.strictEqual(describeUnsupportedNodeRuntime(), null);
  });

  it('keeps the documented minimum in sync with the guard', () => {
    assert.strictEqual(MIN_NODE_VERSION, '22.14.0');
    assert.strictEqual(MIN_NAPI_VERSION, 10);
    const pkg = require('../package.json');
    assert.strictEqual(pkg.engines.node, `>=${MIN_NODE_VERSION}`);
  });
});
