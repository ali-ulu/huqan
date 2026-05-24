const fs = require('fs');
const path = require('path');

const EVENTS = ['beforeLearn', 'afterLearn', 'beforeAsk', 'afterAsk', 'beforeDream', 'afterDream', 'beforeEmbedding', 'afterEmbedding', 'beforeIntrospect', 'afterIntrospect'];

class PluginManager {
  constructor(kernel) {
    this.kernel = kernel;
    this.plugins = [];
    this._handlers = {};
    for (const e of EVENTS) this._handlers[e] = [];
  }

  load(dir) {
    const pDir = path.resolve(dir);
    if (!fs.existsSync(pDir)) return 0;
    const files = fs.readdirSync(pDir).filter(f => f.endsWith('.js'));
    let count = 0;
    for (const file of files) {
      try {
        const plugin = require(path.join(pDir, file));
        this.register(plugin);
        count++;
      } catch (err) {
        console.error(`Plugin yüklenemedi: ${file} - ${err.message}`);
      }
    }
    return count;
  }

  register(plugin) {
    if (!plugin || !plugin.name) return;
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
        console.error(`Plugin hatası [${plugin.name}][${event}]: ${err.message}`);
      }
    }
    return data;
  }
}

module.exports = PluginManager;
