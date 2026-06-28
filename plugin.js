const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS = [
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

function verifyPluginFile(filePath, opts = {}) {
  const strict = opts.strict === true;
  const signatureKey = opts.signatureKey || process.env.AXIOM_PLUGIN_SIGNING_KEY || '';
  const currentHash = hashFile(filePath);
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
    this.strictPlugins = process.env.AXIOM_PLUGIN_STRICT !== '0';
    this.pluginSigningKey = process.env.AXIOM_PLUGIN_SIGNING_KEY || '';
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
          signatureKey: this.pluginSigningKey,
        });
        if (!verification.ok) {
          console.error(`Plugin yuklenemedi: ${file} - ${verification.reason}`);
          continue;
        }
        const plugin = require(filePath);
        plugin.__verification = verification;
        this.register(plugin);
        count++;
      } catch (err) {
        console.error(`Plugin yuklenemedi: ${file} - ${err.message}`);
      }
    }
    return count;
  }

  register(plugin) {
    if (!plugin || !plugin.name) return;
    if (this.plugins.some(existing => existing.name === plugin.name)) return;
    const dependencyCheck = this._validatePluginDependencies(plugin);
    if (!dependencyCheck.ok) {
      throw new Error(dependencyCheck.reason);
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
