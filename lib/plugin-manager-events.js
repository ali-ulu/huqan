// PluginManager's hook dispatch (plugin.js).

// Only the input-transform hooks expose returned extension fields as annotations.
// They are descriptive plugin output, never gate authority or signed receipt data.
function applyInputHookResult(event, data, result, pluginName, input) {
  const fields = event === 'beforeLearn' ? ['text', 'opts']
    : event === 'beforeAsk' ? ['question', 'workspaceId'] : null;
  if (!fields || !result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.then === 'function') return result;
  const annotations = Object.fromEntries(Object.entries(result)
    .filter(([key, value]) => !fields.includes(key) && key !== 'annotations'
      && (!Object.hasOwn(input, key) || input[key] !== value)));
  // Preserve extension fields for later hooks, without attributing an unchanged
  // field from an earlier plugin to every plugin that returns the full payload.
  const next = { ...data, ...result };
  if (data.annotations) next.annotations = data.annotations;
  else delete next.annotations;
  if (Object.keys(annotations).length) {
    next.annotations = { ...data.annotations, [pluginName]: annotations };
  }
  return next;
}

function attachPluginAnnotations(result, annotations) {
  if (!annotations || !Object.keys(annotations).length) return result;
  return { ...result, data: { ...result.data, annotations } };
}

function emit(event, data) {
  for (const plugin of this._handlers[event] || []) {
    try {
      const input = event === 'beforeAsk' ? { ...data } : data;
      const result = plugin[event](this.kernel, data);
      if (event === 'beforeAsk' && result && typeof result === 'object'
          && !Array.isArray(result) && typeof result.then !== 'function') {
        Object.assign(data, applyInputHookResult(event, data, result, plugin.name, input));
      }
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
    const input = event === 'beforeLearn' || event === 'beforeAsk' ? { ...nextData } : nextData;
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
      nextData = applyInputHookResult(event, nextData, result, plugin.name, input);
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

module.exports = { installPluginEventMethods, attachPluginAnnotations };
