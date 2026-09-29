'use strict';

// Kernel capability flags and the plugin-capability surface, moved out of
// kernel.js (#2122). Installed on Kernel.prototype by kernel.js with the
// descriptors they had as class methods; `this` is the Kernel instance
// (its capabilities map and PluginManager).

const { DEFAULT_CAPABILITIES } = require('./kernel-contract');
const { installKernelMethods } = require('./kernel-method-install');

class KernelCapabilityMethods {
  hasCapability(name) {
    return Boolean(this.capabilities && this.capabilities[name] === true);
  }

  enableCapability(name) {
    if (typeof name !== 'string' || !Object.hasOwn(DEFAULT_CAPABILITIES, name)) { // own-prop, not `in`: `in` walked the prototype chain (#1204)
      const error = new Error(`Unknown capability: ${name}`);
      error.code = 'CAPABILITY_UNKNOWN';
      error.capability = name;
      throw error;
    }
    this.capabilities[name] = true;
    if (
      this.plugins &&
      typeof this.plugins.emit === 'function' &&
      this.plugins._handlers &&
      Array.isArray(this.plugins._handlers['capability:enabled'])
    ) {
      this.plugins.emit('capability:enabled', { name });
    }
    return true;
  }

  requireCapability(name) {
    if (this.hasCapability(name)) return true;
    const error = new Error(`Required capability is not enabled: ${name}`);
    error.code = 'CAPABILITY_REQUIRED';
    error.capability = name;
    throw error;
  }

  usePlugin(plugin) {
    this.plugins.register(plugin);
  }

  listCapabilities() {
    if (!this.plugins || typeof this.plugins.listCapabilities !== 'function') return [];
    return this.plugins.listCapabilities();
  }

  getCapability(name) {
    if (!this.plugins || typeof this.plugins.getCapability !== 'function') return null;
    return this.plugins.getCapability(name);
  }

  async runCapability(name, input, opts = {}) {
    this.requireCapability('pluginCapabilities');
    if (!this.plugins || typeof this.plugins.runCapability !== 'function') {
      throw new Error('Plugin manager is unavailable.');
    }
    return this.plugins.runCapability(name, input, opts);
  }
}

function install(Kernel) {
  installKernelMethods(Kernel, KernelCapabilityMethods);
}

module.exports = { install };
