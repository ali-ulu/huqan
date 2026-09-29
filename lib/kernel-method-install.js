'use strict';

// Installs the methods of a holder class onto Kernel.prototype with the exact
// descriptors they had as Kernel class members (non-enumerable, writable,
// configurable; a getter stays a getter), so Object.keys, for...in and the
// prototype name list over a Kernel do not change when a method group moves
// out of kernel.js (#2122). Same install shape as lib/kernel-v2-forwarding.js.
// A name Kernel already defines is refused rather than silently replaced.
function installKernelMethods(Kernel, Holder) {
  for (const name of Object.getOwnPropertyNames(Holder.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(Kernel.prototype, name)) {
      throw new Error(`installKernelMethods: Kernel.prototype.${name} is already defined`);
    }
    Object.defineProperty(Kernel.prototype, name, Object.getOwnPropertyDescriptor(Holder.prototype, name));
  }
}

module.exports = { installKernelMethods };
