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

/**
 * Synchronous MCP gate evidence hook. Each handler receives its own copy of
 * { tool, args, metadata }, including the evaluated text in args. Return
 * undefined for no signal, or { decision: 'allow'|'review'|'dry_run_only'|'block',
 * reason?: string }. Signals are collected, never threaded/replaced like
 * emitStrict payloads; only the core gate merges them into a final verdict.
 * Errors, promises and malformed signals fail closed. Plugins remain trusted
 * in-process code, not sandboxed code.
 */
function collectGateEvidence(data) {
  const findings = [];
  for (const plugin of this._handlers.beforeGateDecision || []) {
    try {
      const signal = plugin.beforeGateDecision(this.kernel, structuredClone(data));
      if (signal === undefined) continue;
      if (signal && typeof signal.then === 'function') {
        // Consume a rejected promise too: the synchronous call is blocked,
        // but its later rejection must not terminate the host process.
        Promise.resolve(signal).catch(() => {});
        throw new TypeError('beforeGateDecision must be synchronous');
      }
      if (!signal || typeof signal !== 'object' || Array.isArray(signal)
        || !['allow', 'review', 'dry_run_only', 'block'].includes(signal.decision)
        || (signal.reason !== undefined && typeof signal.reason !== 'string')) {
        throw new TypeError('Invalid gate evidence');
      }
      findings.push({
        gate: 'plugin', plugin: plugin.name, tool: data.tool,
        decision: signal.decision,
        reason: signal.reason?.slice(0, 256) || 'plugin_gate_signal',
      });
    } catch (_) {
      // Do not copy exception messages (which can contain evaluated text)
      // into telemetry or approval records.
      findings.push({
        gate: 'plugin', plugin: plugin.name, tool: data.tool,
        decision: 'block', reason: 'plugin_gate_error', failClosed: true,
      });
    }
  }
  return findings;
}

function installMethods(proto, methods) {
  for (const method of methods) {
    Object.defineProperty(proto, method.name, {
      value: method, writable: true, configurable: true, enumerable: false,
    });
  }
}

function installPluginEventMethods(proto) {
  installMethods(proto, [emit, emitStrict, emitStrictAsync, collectGateEvidence]);
}

module.exports = { installPluginEventMethods };
