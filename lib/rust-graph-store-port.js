'use strict';

// GraphStorePort adapter for RustGraph (#2906). huqan-core is an accelerator,
// not a second graph authority: once the bridge has fallen back, persistence
// belongs to the JavaScript Graph and its own GraphStorePort; otherwise the
// process receives the save/load wire commands.
//
// The fallback check runs before send(), exactly as RustGraph did inline, so a
// bridge whose fallback is built lazily by send() keeps its prior results.

const RUST_GRAPH_STORE_PORT_METHODS = Object.freeze(['backend', 'save', 'load']);

function createRustGraphStorePort(bridge) {
  if (!bridge || typeof bridge.send !== 'function') {
    throw new TypeError('RustGraphStorePort requires a RustGraph bridge');
  }

  async function persist(cmd, memPath) {
    if (bridge._fallback) { bridge._fallback[cmd](); return undefined; }
    const res = await bridge.send({ cmd, path: memPath || bridge.memoryPath });
    return res && res.ok;
  }

  return Object.freeze({
    backend() {
      if (bridge._fallback) return 'js-fallback';
      return bridge._proc ? 'rust-process' : 'unstarted';
    },
    save: memPath => persist('save', memPath),
    load: memPath => persist('load', memPath),
  });
}

module.exports = {
  RUST_GRAPH_STORE_PORT_METHODS,
  createRustGraphStorePort,
};
