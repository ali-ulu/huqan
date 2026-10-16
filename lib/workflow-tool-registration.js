'use strict';

// A plain registration descriptor is untrusted data. Only this module can mint
// the marker used by the default workflow registrar to assert receiver-owned
// internal authority; a caller-supplied `kind: 'internal'` is never enough for
// the firewall bypass.
const RECEIVER_OWNED_INTERNAL_TOOL = Symbol('huqan-receiver-owned-internal-tool');

function registerReceiverOwnedTool(registry, tool = {}) {
  if (!registry || typeof registry.registerTool !== 'function') {
    throw new Error('Registry with registerTool() is required.');
  }
  const receiverTool = { ...tool, kind: 'internal' };
  Object.defineProperty(receiverTool, RECEIVER_OWNED_INTERNAL_TOOL, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return registry.registerTool(receiverTool);
}

module.exports = Object.freeze({ RECEIVER_OWNED_INTERNAL_TOOL, registerReceiverOwnedTool });
