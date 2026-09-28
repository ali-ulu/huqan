'use strict';

// Installs the methods of a holder class onto MemoryStore.prototype with the
// exact descriptors they had as MemoryStore class members (non-enumerable,
// writable, configurable), so the prototype surface, arity and enumerability
// do not change when a method group moves out of lib/memory-store.js (#2120).
// Same install shape as lib/kernel-method-install.js (#2122).
// A name MemoryStore already defines is refused rather than silently replaced.
function installMemoryStoreMethods(MemoryStore, Holder) {
  for (const name of Object.getOwnPropertyNames(Holder.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(MemoryStore.prototype, name)) {
      throw new Error(`installMemoryStoreMethods: MemoryStore.prototype.${name} is already defined`);
    }
    Object.defineProperty(MemoryStore.prototype, name, Object.getOwnPropertyDescriptor(Holder.prototype, name));
  }
}

module.exports = { installMemoryStoreMethods };
