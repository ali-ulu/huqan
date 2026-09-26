const fs = require('fs');
const path = require('path');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const { createProvenanceRegistry } = require('./lib/plugin-provenance-registry');
const {
  VERIFIED_PLUGIN,
  hashFile,
  hmacSign,
  loadActivationGate,
  verifyPluginFile,
  isRuntimePluginFile,
} = require('./lib/plugin-verification');
const { installPluginRegisterMethods } = require('./lib/plugin-manager-register');
const { installPluginGrantMethods } = require('./lib/plugin-manager-grants');
const { installPluginEventMethods } = require('./lib/plugin-manager-events');
const { installPluginProvenanceMethods } = require('./lib/plugin-manager-provenance');

// preIngest is the one async-allowed hook: it runs via emitStrictAsync()
// from kernel.learnAsync(), *before* the synchronous learn() pipeline
// starts, precisely so a handler that needs I/O (network reachability of an
// evidence URL, say) has somewhere to live that is not beforeLearn. See
// #348 -- beforeLearn stays synchronous on purpose.
//
// Note: plugin-boundary-contract.test.js parses this array straight out of
// the source and will not tolerate comments *inside* the literal.
const EVENTS = [
  'preIngest',
  'beforeLearn',
  'afterLearn',
  'beforeAsk',
  'afterAsk',
  'beforeDream',
  'afterDream',
  'beforeEmbedding',
  'afterEmbedding',
  'beforeIntrospect',
  'afterIntrospect',
  'beforePlan',
  'afterPlan',
  'beforeTask',
  'afterTask',
  'beforeAgentRun',
  'afterAgentRun',
  'afterGateDecision',
];

class PluginManager {
  constructor(kernel) {
    this.kernel = kernel;
    this.plugins = [];
    this._handlers = {};
    this.pluginSigningKey = readCompatibleEnvironmentVariable('PLUGIN_SIGNING_KEY') || '';
    this.productionPluginEnforcement =
      readCompatibleEnvironmentVariable('PLUGIN_PRODUCTION_ENFORCEMENT') === '1' ||
      process.env.NODE_ENV === 'production';
    this.strictPlugins =
      this.productionPluginEnforcement || readCompatibleEnvironmentVariable('PLUGIN_STRICT') !== '0';
    this.activationGate = loadActivationGate();
    // #1890: every load records signature, publisher provenance, version,
    // and granted capabilities; the graph below is verified at load and
    // re-evaluated at runtime (runCapability / revalidatePlugins).
    this.provenanceRegistry = createProvenanceRegistry();
    // Capability skips are a configuration state, not output (#1694). They are
    // collected here so `huqan status` can report them on request instead of
    // every command announcing them.
    this.capabilityNotices = [];
    for (const e of EVENTS) this._handlers[e] = [];
  }

  /**
   * Record a plugin that declined, or loaded with an optional feature off.
   * Deduplicated: load() may run more than once in a process.
   */
  recordCapabilityNotice({ plugin, capability, kind }) {
    const notice = { plugin: String(plugin || ''), capability: String(capability || ''), kind };
    const seen = this.capabilityNotices.some(existing => existing.plugin === notice.plugin
      && existing.capability === notice.capability && existing.kind === notice.kind);
    if (!seen) this.capabilityNotices.push(notice);
    return notice;
  }

  load(dir) {
    const pDir = path.resolve(dir);
    if (!fs.existsSync(pDir)) return 0;
    if (this.productionPluginEnforcement && !this.activationGate) {
      console.error('Plugin loading refused: production supply-chain activation policy is required.');
      return 0;
    }
    const files = fs.readdirSync(pDir).filter(isRuntimePluginFile);
    let count = 0;
    for (const file of files) {
      const filePath = path.join(pDir, file);
      try {
        const verification = verifyPluginFile(filePath, {
          strict: this.strictPlugins,
          productionEnforcement: this.productionPluginEnforcement,
          signatureKey: this.pluginSigningKey,
        });
        if (!verification.ok) {
          console.error(`Plugin failed to load: ${file} - ${verification.reason}`);
          continue;
        }
        // Verification passed, so this is the approved file -- and that is the
        // whole of the guarantee. require() gives the plugin the host process's
        // privileges (#362); see verifyPluginFile above.
        const plugin = require(filePath);
        const descriptor = this._validatePluginDescriptor(plugin, verification);
        if (!descriptor.ok) {
          console.error(`Plugin failed to load: ${file} - ${descriptor.reason}`);
          continue;
        }
        const activation = this._activatePlugin(plugin, verification);
        plugin.__activation = activation;
        plugin.__verification = verification;
        if (Object.prototype.hasOwnProperty.call(plugin, VERIFIED_PLUGIN)) {
          plugin[VERIFIED_PLUGIN] = verification;
        } else {
          Object.defineProperty(plugin, VERIFIED_PLUGIN, {
            value: verification,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
        this.register(plugin);
        count++;
      } catch (err) {
        if (err && err.code === 'PLUGIN_CAPABILITY_DISABLED') {
          // Three of the bundled plugins (company-brain, repo-memory,
          // contradiction-alert) require companyMode or temporal, both off by
          // default in kernel.js DEFAULT_CAPABILITIES. This is a skip, not a
          // failure -- and it is the *expected* state, so it is recorded rather
          // than printed (#1694). Writing five of these to stderr on every
          // single command made a correct default configuration look like a
          // half-broken install, and polluted --json output on the way past.
          // `huqan status` reports what was skipped and which capability each
          // one wants.
          this.recordCapabilityNotice({
            plugin: err.pluginName || file,
            capability: err.capability,
            kind: 'required',
          });
          continue;
        }
        console.error(`Plugin failed to load: ${file} - ${err.message}`);
      }
    }
    // #1890: the dependency graph is verified once the whole directory is
    // recorded. A dependency can legitimately load after its dependent
    // (alphabetical order), so per-file verification here would evict plugins
    // whose dependency simply had not loaded yet.
    this._evictDependencyOffenders();
    return count;
  }


  /**
   * Remove plugins whose recorded dependency edges do not resolve (or form a
   * cycle) from the active set. Records keep the verdict as `depStatus` so
   * `huqan status` can say why a plugin is gone.
   */

  listCapabilities() {
    return this.plugins.flatMap(plugin => {
      const capabilities = Array.isArray(plugin.capabilities) ? plugin.capabilities : [];
      return capabilities.map(capability => ({
        plugin: plugin.name,
        ...capability,
      }));
    });
  }

  getCapability(name) {
    if (!name) return null;
    return this.listCapabilities().find(capability => capability.name === name || capability.command === name) || null;
  }
}

// Registration, grant checks, hook dispatch and provenance queries live in
// lib/plugin-manager-*; installed as non-enumerable prototype methods, exactly
// as class methods are.
installPluginRegisterMethods(PluginManager.prototype, { EVENTS });
installPluginGrantMethods(PluginManager.prototype);
installPluginEventMethods(PluginManager.prototype);
installPluginProvenanceMethods(PluginManager.prototype);

module.exports = PluginManager;
module.exports.hashFile = hashFile;
module.exports.hmacSign = hmacSign;
module.exports.verifyPluginFile = verifyPluginFile;
module.exports.isRuntimePluginFile = isRuntimePluginFile;
