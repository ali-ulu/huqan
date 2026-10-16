'use strict';

// Installs the methods of a holder class onto AgentV3.prototype with the exact
// descriptors they had as AgentV3 class members (non-enumerable, writable,
// configurable), so Object.keys, for...in and the prototype name list over an
// AgentV3 do not change when a method group moves out of agent.v3.js (#2120).
// Same install shape as lib/kernel-method-install.js. A name AgentV3 already
// defines is refused rather than silently replaced.
function installAgentV3Methods(AgentV3, Holder) {
  for (const name of Object.getOwnPropertyNames(Holder.prototype)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(AgentV3.prototype, name)) {
      throw new Error(`installAgentV3Methods: AgentV3.prototype.${name} is already defined`);
    }
    Object.defineProperty(AgentV3.prototype, name, Object.getOwnPropertyDescriptor(Holder.prototype, name));
  }
}

module.exports = { installAgentV3Methods };
