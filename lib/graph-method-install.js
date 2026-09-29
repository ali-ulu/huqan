'use strict';

// Installs the methods of a holder class onto Graph.prototype with the exact
// descriptors they had as Graph class members (non-enumerable, writable,
// configurable), so the prototype surface, arity and enumerability do not
// change when a method group moves out of graph.js (#3101). Same install shape
// as lib/kernel-method-install.js (#2122).
// A name Graph already defines is refused rather than silently replaced.
function installGraphMethods(Graph, Holder) {
  for (const name of Object.getOwnPropertyNames(Holder.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(Graph.prototype, name)) {
      throw new Error(`installGraphMethods: Graph.prototype.${name} is already defined`);
    }
    Object.defineProperty(Graph.prototype, name, Object.getOwnPropertyDescriptor(Holder.prototype, name));
  }
}

module.exports = { installGraphMethods };
