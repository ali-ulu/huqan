// PluginManager's hook dispatch (plugin.js).

function emit(event, data) {
  for (const plugin of this._handlers[event] || []) {
    try {
      plugin[event](this.kernel, data);
    } catch (err) {
      console.error(`Plugin hatasi [${plugin.name}][${event}]: ${err.message}`);
    }
  }
  return data;
}


function emitStrict(event, data) {
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
async function emitStrictAsync(event, data) {
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

function installMethods(proto, methods) {
  for (const method of methods) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

function installPluginEventMethods(proto) {
  installMethods(proto, [emit, emitStrict, emitStrictAsync]);
}

module.exports = { installPluginEventMethods };
