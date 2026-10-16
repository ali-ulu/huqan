const fs = require('fs');
const { revalidatePlugin, revalidateAll } = require('./plugin-provenance-registry');
const { VERIFIED_PLUGIN, hashFile } = require('./plugin-verification');
const { normalizedCapabilityNames, pluginComponent } = require('./plugin-capability-records');

// PluginManager's grant checks (plugin.js): descriptor and dependency
// validation at load, activation, and the runtime re-validation that runs on
// every capability invocation.

function _hasVerifiedProvenance(plugin) {
  const verification = plugin && plugin[VERIFIED_PLUGIN];
  return Boolean(verification && verification.ok === true);
}


function _validatePluginDescriptor(plugin, verification) {
  const declaredRaw = verification?.manifest?.capabilities;
  if (declaredRaw === undefined) {
    if (this.activationGate) {
      return {
        ok: false,
        reason: 'Plugin manifest capabilities are required by the activation policy.',
        code: 'PLUGIN_CAPABILITIES_MISSING',
      };
    }
    return { ok: true };
  }
  const declared = normalizedCapabilityNames(declaredRaw);
  const actual = normalizedCapabilityNames(plugin?.capabilities) || [];
  if (!declared) {
    return {
      ok: false,
      reason: 'Plugin manifest capabilities are invalid.',
      code: 'PLUGIN_CAPABILITIES_INVALID',
    };
  }
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    return {
      ok: false,
      reason: 'Plugin manifest capabilities do not match the loaded descriptor.',
      code: 'PLUGIN_CAPABILITIES_MISMATCH',
    };
  }
  return { ok: true };
}


function _activatePlugin(plugin, verification) {
  if (!this.activationGate) return null;
  return this.activationGate.activate(pluginComponent(plugin, verification));
}


function _validatePluginDependencies(plugin) {
  const required = Array.isArray(plugin.requires) ? plugin.requires : [];
  for (const capability of required) {
    if (!this.kernel || typeof this.kernel.hasCapability !== 'function' || !this.kernel.hasCapability(capability)) {
      return {
        ok: false,
        reason: `Plugin "${plugin.name}" requires missing capability: ${capability}`,
        capability,
      };
    }
  }
  return { ok: true };
}


function _reattestPlugin(plugin) {
  if (!this.activationGate) return;
  const verification = plugin && plugin[VERIFIED_PLUGIN];
  if (!verification || !verification.filePath || hashFile(verification.filePath) !== verification.sha256) {
    const error = new Error('Supply-chain activation rejected: hash-drift');
    error.code = 'SUPPLY_CHAIN_ACTIVATION_REJECTED';
    throw error;
  }
  this.activationGate.reattest(pluginComponent(plugin, verification));
}


async function runCapability(name, input, opts = {}) {
  const capability = this.getCapability(name);
  if (!capability) {
    throw new Error(`Unknown plugin capability: ${name}`);
  }
  const plugin = this.plugins.find(item => item.name === capability.plugin);
  if (!plugin || typeof plugin.run !== 'function') {
    throw new Error(`Plugin "${capability.plugin}" cannot run capability: ${name}`);
  }
  // The activation gate is the authoritative policy boundary (allowlist,
  // revocation with its incident reason, expiry), so it is consulted first
  // and its rejection reason is what the operator sees.
  this._reattestPlugin(plugin);
  // #1890: a grant checked only at load/install silently survives upgrades,
  // hash drift, and capabilities switched off afterwards. Re-evaluate the
  // recorded grant against live state on every invocation, fail-closed.
  // Runs behind the gate: both fail closed, so this only narrows which
  // reason surfaces, never whether the call is blocked.
  this._revalidateRuntimeGrant(plugin);
  return plugin.run(this.kernel, input, {
    ...opts,
    capability,
  });
}


/**
 * Per-invocation re-evaluation of the grant recorded at load: file hash,
 * capability set, still-enabled kernel capabilities, and still-satisfied
 * plugin dependencies. Throws PLUGIN_RUNTIME_REVALIDATION_FAILED rather
 * than running a plugin whose grant drifted.
 */
function _revalidateRuntimeGrant(plugin) {
  const verification = plugin[VERIFIED_PLUGIN];
  let liveHash = '';
  if (verification && verification.filePath && fs.existsSync(verification.filePath)) {
    try { liveHash = hashFile(verification.filePath); } catch (_) { liveHash = ''; }
  }
  const live = {
    version: verification && verification.manifest ? verification.manifest.version : plugin.version,
    contentHash: liveHash,
    capabilities: normalizedCapabilityNames(plugin.capabilities) || [],
  };
  const outcome = revalidatePlugin(this.provenanceRegistry, plugin.name, live, {
    hasCapability: capability => Boolean(this.kernel
      && typeof this.kernel.hasCapability === 'function' && this.kernel.hasCapability(capability)),
    requiredCapabilities: Array.isArray(plugin.requires) ? plugin.requires : [],
    loadedPlugins: this.plugins.map(item => item.name),
  });
  if (!outcome.ok) {
    const error = new Error(`Plugin "${plugin.name}" failed runtime grant re-validation: ${outcome.reason}`
      + (outcome.capability ? ` (${outcome.capability})` : '')
      + (outcome.dependency ? ` (${outcome.dependency})` : ''));
    error.code = 'PLUGIN_RUNTIME_REVALIDATION_FAILED';
    error.reason = outcome.reason;
    throw error;
  }
  return outcome;
}


/**
 * Periodic re-validation entry point (#1890): re-evaluate every recorded
 * grant against live state without invoking anything. Returns per-plugin
 * `{ plugin, ok, reason }` results; callers decide whether a failure only
 * pages or also evicts.
 */
function revalidatePlugins() {
  const liveByName = new Map(this.plugins.map(plugin => [plugin.name, plugin]));
  return revalidateAll(this.provenanceRegistry, name => {
    const plugin = liveByName.get(name);
    if (!plugin) return { capabilities: [] };
    const verification = plugin[VERIFIED_PLUGIN];
    let liveHash = '';
    if (verification && verification.filePath && fs.existsSync(verification.filePath)) {
      try { liveHash = hashFile(verification.filePath); } catch (_) { liveHash = ''; }
    }
    return {
      version: verification && verification.manifest ? verification.manifest.version : plugin.version,
      contentHash: liveHash,
      capabilities: normalizedCapabilityNames(plugin.capabilities) || [],
    };
  }, {
    hasCapability: capability => Boolean(this.kernel
      && typeof this.kernel.hasCapability === 'function' && this.kernel.hasCapability(capability)),
    loadedPlugins: this.plugins.map(item => item.name),
  });
}

function installMethods(proto, methods) {
  for (const method of methods) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

function installPluginGrantMethods(proto) {
  installMethods(proto, [
    _hasVerifiedProvenance, _validatePluginDescriptor, _activatePlugin, _validatePluginDependencies,
    _reattestPlugin, runCapability, _revalidateRuntimeGrant, revalidatePlugins,
  ]);
}

module.exports = { installPluginGrantMethods };
