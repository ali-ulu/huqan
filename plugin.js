const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const { createActivationGate } = require('./lib/supply-chain-activation-gate');
const {
  createProvenanceRegistry,
  recordPluginLoad,
  markDepStatus,
  markRevoked,
  verifyDependencyGraph,
  dependencyGraph,
  revalidatePlugin,
  revalidateAll,
  getRecord,
  listRecords,
  listChangelog,
} = require('./lib/plugin-provenance-registry');

const VERIFIED_PLUGIN = Symbol('axiom.verifiedPlugin');

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

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hmacSign(value, signingKey) {
  return crypto.createHmac('sha256', String(signingKey)).update(String(value)).digest('hex');
}

function getManifestPath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function readManifest(filePath) {
  const manifestPath = getManifestPath(filePath);
  if (!fs.existsSync(manifestPath)) return null;
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function loadActivationGate() {
  const raw = readCompatibleEnvironmentVariable('SUPPLY_CHAIN_ACTIVATION_POLICY');
  if (!raw) return null;
  try { return createActivationGate(JSON.parse(raw)); } catch (error) {
    const wrapped = new Error(`Invalid supply-chain activation policy: ${error.message}`);
    wrapped.code = 'SUPPLY_CHAIN_ACTIVATION_POLICY_INVALID';
    throw wrapped;
  }
}

function normalizedCapabilityNames(value) {
  if (!Array.isArray(value)) return null;
  const names = value.map(item => typeof item === 'string' ? item : item?.name);
  if (names.some(name => typeof name !== 'string' || !name.trim())) return null;
  return [...new Set(names.map(name => name.trim()))].sort();
}

function pluginComponent(plugin, verification) {
  const manifest = verification.manifest || {};
  return { componentType: 'plugin', name: plugin.name, version: manifest.version,
    contentHash: verification.sha256, issuer: manifest.issuer, workspaceId: manifest.workspaceId,
    capabilities: normalizedCapabilityNames(manifest.capabilities)
      || normalizedCapabilityNames(plugin.capabilities) || [], expiresAt: manifest.expiresAt };
}

/**
 * Provenance entry for the registry (#1890): signature status, publisher
 * provenance (issuer), version, content hash, granted capabilities, and
 * declared plugin-to-plugin dependencies. Programmatic plugins carry no
 * verification, so their origin is recorded explicitly as unverified rather
 * than inheriting trust they never presented.
 */
function provenanceEntryFor(plugin, verification) {
  const manifest = (verification && verification.manifest) || {};
  const manifestValue = name => typeof manifest[name] === 'string' && manifest[name].trim() ? manifest[name].trim() : '';
  const declared = normalizedCapabilityNames(manifest.capabilities)
    || normalizedCapabilityNames(plugin.capabilities) || [];
  const rawDeps = Array.isArray(plugin.dependsOn) ? plugin.dependsOn : [];
  return {
    name: plugin.name,
    version: manifestValue('version') || (typeof plugin.version === 'string' && plugin.version.trim() ? plugin.version.trim() : ''),
    issuer: manifestValue('issuer') || (typeof plugin.issuer === 'string' && plugin.issuer.trim() ? plugin.issuer.trim() : ''),
    workspaceId: manifestValue('workspaceId'),
    signatureStatus: verification ? verification.status : 'unverified',
    contentHash: (verification && verification.sha256) || '',
    capabilities: declared,
    dependencies: rawDeps,
    filePath: (verification && verification.filePath) || '',
  };
}

/**
 * Verifies that a plugin file is the one the operator approved.
 *
 * #362: read the status names literally. 'verified' means the file matches its
 * adjacent manifest hash; 'verified-signed' means that hash is HMAC-signed with
 * the deployment key. Neither says anything about what the plugin *does* --
 * there is no sandbox, and load() below hands the file straight to require(),
 * so a perfectly signed plugin still runs in-process with full host privileges.
 * Signing answers "is this the code we approved?", not "is this code allowed to
 * do that?".
 *
 * That gap is documented on purpose -- docs/core-plugin-boundary-contract.md
 * ("Enforcement Boundary: Signed Is Not Sandboxed") and THREAT_MODEL.md
 * ("Plugin Code Execution"). Do not close it by wrapping require() in vm: the
 * vm module is not a security boundary, so that would advertise confinement the
 * runtime cannot deliver.
 */
function verifyPluginFile(filePath, opts = {}) {
  const strict = opts.strict === true;
  const productionEnforcement = opts.productionEnforcement === true;
  const signatureKey = opts.signatureKey || readCompatibleEnvironmentVariable('PLUGIN_SIGNING_KEY') || '';
  const currentHash = hashFile(filePath);

  // #391: hash-only verification proves a plugin file matches its adjacent
  // manifest.json -- nothing more. An attacker with filesystem write access
  // can rewrite both together, so once production enforcement is active, a
  // missing signing key must not silently fall back to that weaker
  // guarantee. This is narrower than plain `strict` (which defaults on
  // everywhere HUQAN_PLUGIN_STRICT isn't explicitly '0', including normal
  // dev/test runs loading unsigned first-party plugins) -- only actual
  // production enforcement requires a signing key to load anything at all.
  if (productionEnforcement && !signatureKey) {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath: getManifestPath(filePath),
      reason: 'Plugin signing key is required under production enforcement.',
    };
  }

  const manifestRecord = readManifest(filePath);

  if (!manifestRecord) {
    return {
      ok: !strict,
      status: strict ? 'rejected' : 'unverified',
      sha256: currentHash,
      manifestPath: getManifestPath(filePath),
      reason: strict ? 'Plugin manifest is required in strict mode.' : 'Plugin manifest not found.',
    };
  }

  const { manifest, manifestPath } = manifestRecord;
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath,
      reason: 'Plugin manifest is invalid.',
    };
  }

  if (manifest.sha256 !== currentHash) {
    return {
      ok: false,
      status: 'rejected',
      sha256: currentHash,
      manifestPath,
      reason: 'Plugin hash mismatch.',
    };
  }

  if (signatureKey) {
    if (!manifest.signature) {
      return {
        ok: !strict,
        status: strict ? 'rejected' : 'hash-only',
        sha256: currentHash,
        manifestPath,
        reason: strict ? 'Plugin signature is required in strict mode.' : 'Plugin signature not found.',
      };
    }
    const expectedSignature = hmacSign(currentHash, signatureKey);
    if (manifest.signature !== expectedSignature) {
      return {
        ok: false,
        status: 'rejected',
        sha256: currentHash,
        manifestPath,
        reason: 'Plugin signature mismatch.',
      };
    }
  }

  return {
    ok: true,
    status: signatureKey ? 'verified-signed' : 'verified',
    sha256: currentHash,
    manifestPath,
    manifest,
    filePath,
    reason: signatureKey ? 'Plugin hash and signature verified.' : 'Plugin hash verified.',
  };
}

function isRuntimePluginFile(fileName) {
  return (
    fileName.endsWith('.js') &&
    !fileName.endsWith('.test.js') &&
    !fileName.endsWith('.spec.js')
  );
}

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

  /**
   * What a reader of `huqan status` needs: which plugins are active, which
   * declined and what each one is waiting for.
   */
  capabilitySummary() {
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
  _evictDependencyOffenders() {
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

  register(plugin) {
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

  _hasVerifiedProvenance(plugin) {
    const verification = plugin && plugin[VERIFIED_PLUGIN];
    return Boolean(verification && verification.ok === true);
  }

  _validatePluginDescriptor(plugin, verification) {
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

  _activatePlugin(plugin, verification) {
    if (!this.activationGate) return null;
    return this.activationGate.activate(pluginComponent(plugin, verification));
  }

  revokePlugin(name, reason = 'revoked') {
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

  listActivationInventory() {
    return this.activationGate ? this.activationGate.inventory() : [];
  }

  /** #1890: provenance, dependency graph, and capability changelog queries. */
  provenanceRecord(name) {
    return getRecord(this.provenanceRegistry, name);
  }

  provenanceInventory() {
    return listRecords(this.provenanceRegistry);
  }

  dependencyGraph() {
    return dependencyGraph(this.provenanceRegistry);
  }

  capabilityChangelog() {
    return listChangelog(this.provenanceRegistry);
  }

  verifyDependencyGraph() {
    return verifyDependencyGraph(this.provenanceRegistry);
  }

  _reattestPlugin(plugin) {
    if (!this.activationGate) return;
    const verification = plugin && plugin[VERIFIED_PLUGIN];
    if (!verification || !verification.filePath || hashFile(verification.filePath) !== verification.sha256) {
      const error = new Error('Supply-chain activation rejected: hash-drift');
      error.code = 'SUPPLY_CHAIN_ACTIVATION_REJECTED';
      throw error;
    }
    this.activationGate.reattest(pluginComponent(plugin, verification));
  }

  emit(event, data) {
    for (const plugin of this._handlers[event]) {
      try {
        plugin[event](this.kernel, data);
      } catch (err) {
        console.error(`Plugin hatasi [${plugin.name}][${event}]: ${err.message}`);
      }
    }
    return data;
  }

  emitStrict(event, data) {
    let nextData = data;
    for (const plugin of this._handlers[event]) {
      if (typeof plugin[event] !== 'function') continue;
      const result = plugin[event](this.kernel, nextData);
      if (result && typeof result.then === 'function') {
        // emitStrict callers (kernel.learn()'s beforeLearn, in particular)
        // are synchronous: they read fields straight off whatever this
        // returns. A plugin returning a Promise here would silently become
        // `nextData`, and the caller would read e.g. `.text` off the
        // Promise object itself (undefined) rather than the resolved
        // value -- no error, just quietly wrong data flowing through the
        // rest of the pipeline. See #348.
        throw new TypeError(
          `Plugin "${plugin.name}" returned a Promise from the synchronous "${event}" hook. `
          + 'emitStrict-driven hooks (beforeLearn and others) run synchronously; '
          + 'an async handler here would silently corrupt the pipeline instead of erroring.'
        );
      }
      if (result !== undefined) {
        nextData = result;
      }
    }
    return nextData;
  }

  /**
   * emitStrict's async sibling: handlers may be sync or async, each is
   * awaited in registration order, and a rejection propagates to the caller
   * (fail-closed) rather than being swallowed the way emit() does.
   *
   * This is the *only* correct way to run a hook whose handlers do I/O.
   * emitStrict() deliberately throws on a thenable result (#348), so an
   * async handler has to be routed here instead.
   */
  async emitStrictAsync(event, data) {
    let nextData = data;
    for (const plugin of this._handlers[event]) {
      if (typeof plugin[event] !== 'function') continue;
      const result = await plugin[event](this.kernel, nextData);
      if (result !== undefined) {
        nextData = result;
      }
    }
    return nextData;
  }

  _validatePluginDependencies(plugin) {
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

  async runCapability(name, input, opts = {}) {
    const capability = this.getCapability(name);
    if (!capability) {
      throw new Error(`Unknown plugin capability: ${name}`);
    }
    const plugin = this.plugins.find(item => item.name === capability.plugin);
    if (!plugin || typeof plugin.run !== 'function') {
      throw new Error(`Plugin "${capability.plugin}" cannot run capability: ${name}`);
    }
    // #1890: a grant checked only at load/install silently survives upgrades,
    // hash drift, and capabilities switched off afterwards. Re-evaluate the
    // recorded grant against live state on every invocation, fail-closed.
    this._revalidateRuntimeGrant(plugin);
    this._reattestPlugin(plugin);
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
  _revalidateRuntimeGrant(plugin) {
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
  revalidatePlugins() {
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
}

module.exports = PluginManager;
module.exports.hashFile = hashFile;
module.exports.hmacSign = hmacSign;
module.exports.verifyPluginFile = verifyPluginFile;
module.exports.isRuntimePluginFile = isRuntimePluginFile;
