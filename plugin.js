const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');

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
    for (const e of EVENTS) this._handlers[e] = [];
  }

  load(dir) {
    const pDir = path.resolve(dir);
    if (!fs.existsSync(pDir)) return 0;
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
          // default in kernel.js DEFAULT_CAPABILITIES. Printing that as a load
          // failure made a correct default configuration look broken on every
          // single startup. It is a skip, and it reads like one.
          console.warn(`[Plugin] ${err.pluginName || file}: skipped — needs capability '${err.capability}', which is disabled`);
          continue;
        }
        console.error(`Plugin failed to load: ${file} - ${err.message}`);
      }
    }
    return count;
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
        console.warn(`[Plugin] ${plugin.name}: optional capability disabled: ${capability}`);
      }
    }
    this.plugins.push(plugin);
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
    return plugin.run(this.kernel, input, {
      ...opts,
      capability,
    });
  }
}

module.exports = PluginManager;
module.exports.hashFile = hashFile;
module.exports.hmacSign = hmacSign;
module.exports.verifyPluginFile = verifyPluginFile;
module.exports.isRuntimePluginFile = isRuntimePluginFile;
