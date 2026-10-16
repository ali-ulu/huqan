const {
  markRevoked,
  verifyDependencyGraph: verifyRegistryDependencyGraph,
  dependencyGraph: registryDependencyGraph,
  getRecord,
  listRecords,
  listChangelog,
} = require('./plugin-provenance-registry');
const { VERIFIED_PLUGIN } = require('./plugin-verification');
const { pluginComponent } = require('./plugin-capability-records');

// PluginManager's status and provenance queries (plugin.js), and revocation.
/**
 * What a reader of `huqan status` needs: which plugins are active, which
 * declined and what each one is waiting for.
 */
function capabilitySummary() {
  const skipped = this.capabilityNotices.filter(notice => notice.kind === 'required');
  const degraded = this.capabilityNotices.filter(notice => notice.kind === 'optional');
  return {
    loaded: this.plugins.map(plugin => plugin.name).sort(),
    skipped: skipped.map(notice => ({ plugin: notice.plugin, capability: notice.capability })),
    degraded: degraded.map(notice => ({ plugin: notice.plugin, capability: notice.capability })),
    // #1890: identity chain per loaded plugin. Additive -- the three
    // fields above keep their shape for existing readers.
    provenance: this.plugins.map(plugin => {
      const record = getRecord(this.provenanceRegistry, plugin.name);
      return {
        plugin: plugin.name,
        version: record ? record.version : 'unversioned',
        issuer: record ? record.issuer : 'unattested',
        signatureStatus: record ? record.signatureStatus : 'unverified',
        capabilities: record ? [...record.capabilities] : [],
      };
    }).sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0)),
  };
}

function revokePlugin(name, reason = 'revoked') {
  if (!this.activationGate) {
    const error = new Error('Supply-chain activation policy is not configured.');
    error.code = 'SUPPLY_CHAIN_ACTIVATION_POLICY_REQUIRED';
    throw error;
  }
  const plugin = this.plugins.find(item => item && item.name === name);
  if (!plugin) {
    const error = new Error(`Unknown plugin: ${name}`);
    error.code = 'PLUGIN_NOT_FOUND';
    throw error;
  }
  const verification = plugin[VERIFIED_PLUGIN];
  const receipt = this.activationGate.revoke(pluginComponent(plugin, verification), reason);
  markRevoked(this.provenanceRegistry, name);
  return receipt;
}

function listActivationInventory() {
  return this.activationGate ? this.activationGate.inventory() : [];
}

/** #1890: provenance, dependency graph, and capability changelog queries. */
function provenanceRecord(name) {
  return getRecord(this.provenanceRegistry, name);
}

function provenanceInventory() {
  return listRecords(this.provenanceRegistry);
}

function dependencyGraph() {
  return registryDependencyGraph(this.provenanceRegistry);
}

function capabilityChangelog() {
  return listChangelog(this.provenanceRegistry);
}

function verifyDependencyGraph() {
  return verifyRegistryDependencyGraph(this.provenanceRegistry);
}

function installMethods(proto, methods) {
  for (const method of methods) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

function installPluginProvenanceMethods(proto) {
  installMethods(proto, [
    capabilitySummary, revokePlugin, listActivationInventory, provenanceRecord,
    provenanceInventory, dependencyGraph, capabilityChangelog, verifyDependencyGraph,
  ]);
}

module.exports = { installPluginProvenanceMethods };
