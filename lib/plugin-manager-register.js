const { markDepStatus, recordPluginLoad, verifyDependencyGraph } = require('./plugin-provenance-registry');
const { VERIFIED_PLUGIN } = require('./plugin-verification');
const { provenanceEntryFor } = require('./plugin-capability-records');

// PluginManager's registration path (plugin.js). EVENTS is handed in so the canonical
// literal stays in plugin.js, where plugin-boundary-contract.test.js reads it.
function installPluginRegisterMethods(proto, { EVENTS }) {
  function _evictDependencyOffenders() {
    const verdict = verifyDependencyGraph(this.provenanceRegistry);
    if (verdict.ok) {
      for (const plugin of this.plugins) markDepStatus(this.provenanceRegistry, plugin.name, 'satisfied');
      return verdict;
    }
    const evicted = new Set([
      ...verdict.unsatisfied.map(item => item.plugin),
      ...verdict.cycles.flat(),
    ]);
    for (const item of verdict.unsatisfied) {
      markDepStatus(this.provenanceRegistry, item.plugin, 'unsatisfied');
      console.error(`Plugin dependency unsatisfied: ${item.plugin} requires ${item.dependency} (${item.reason})`);
    }
    for (const cycle of verdict.cycles) {
      for (const name of cycle) markDepStatus(this.provenanceRegistry, name, 'cyclic');
      console.error(`Plugin dependency cycle: ${cycle.join(' -> ')}`);
    }
    if (evicted.size > 0) {
      this.plugins = this.plugins.filter(plugin => !evicted.has(plugin.name));
      for (const event of EVENTS) {
        this._handlers[event] = this._handlers[event].filter(plugin => !evicted.has(plugin.name));
      }
    }
    for (const plugin of this.plugins) {
      if (!evicted.has(plugin.name)) markDepStatus(this.provenanceRegistry, plugin.name, 'satisfied');
    }
    return verdict;
  }


  function register(plugin) {
    if (!plugin || !plugin.name) return;
    if (this.plugins.some(existing => existing.name === plugin.name)) return;
    if (this.productionPluginEnforcement && !this._hasVerifiedProvenance(plugin)) {
      const error = new Error(`Plugin "${plugin.name}" cannot register without verified production manifest.`);
      error.code = 'PLUGIN_UNVERIFIED_REGISTRATION';
      throw error;
    }
    const dependencyCheck = this._validatePluginDependencies(plugin);
    if (!dependencyCheck.ok) {
      // A required capability being switched off is a configuration state, not
      // a broken plugin. The throw and its message are unchanged -- callers and
      // the boundary contract test depend on both -- but the tag lets the
      // loader report it as a skip instead of a failure.
      const error = new Error(dependencyCheck.reason);
      error.code = 'PLUGIN_CAPABILITY_DISABLED';
      error.pluginName = plugin.name;
      error.capability = dependencyCheck.capability;
      throw error;
    }
    const optional = Array.isArray(plugin.optional) ? plugin.optional : [];
    for (const capability of optional) {
      if (!this.kernel || typeof this.kernel.hasCapability !== 'function' || !this.kernel.hasCapability(capability)) {
        // Recorded, not printed (#1694): the plugin loaded and works, it simply
        // has one optional feature switched off. That is not news on every run.
        this.recordCapabilityNotice({ plugin: plugin.name, capability, kind: 'optional' });
      }
    }
    this.plugins.push(plugin);
    // #1890: record signature, provenance, version, and granted capabilities
    // at load. Plugin-to-plugin edges (`dependsOn`) are recorded here and
    // verified once the load set is complete (load()) and at runtime
    // (runCapability / revalidatePlugins), so load order never evicts a
    // plugin whose dependency simply registers later.
    recordPluginLoad(this.provenanceRegistry, provenanceEntryFor(plugin, plugin[VERIFIED_PLUGIN] || null));
    if (typeof plugin.init === 'function') {
      plugin.init(this.kernel, this);
    }
    for (const event of EVENTS) {
      if (typeof plugin[event] === 'function') {
        this._handlers[event].push(plugin);
      }
    }
  }

  function installMethods(proto, methods) {
    for (const method of methods) {
      Object.defineProperty(proto, method.name, {
        value: method, writable: true, configurable: true, enumerable: false,
      });
    }
  }

  installMethods(proto, [_evictDependencyOffenders, register]);
}

module.exports = { installPluginRegisterMethods };
