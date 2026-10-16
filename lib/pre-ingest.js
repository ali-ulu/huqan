'use strict';

/**
 * Run the async pre-ingest plugin boundary without reaching through Kernel
 * internals. The PluginManager owns handler ordering; this helper owns the
 * payload shape KernelV2 needs before re-entering its synchronous learn path.
 */
async function runPreIngest(plugins, text, opts = {}) {
  const payload = { text, opts: { ...opts } };
  if (!plugins || typeof plugins.emitStrictAsync !== 'function') return payload;

  const result = await plugins.emitStrictAsync('preIngest', payload);
  if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
    const error = new Error('preIngest hook returned a value without a string "text" field; refusing to learn from it');
    error.code = 'PRE_INGEST_INVALID_PAYLOAD';
    throw error;
  }
  return result;
}

module.exports = { runPreIngest };
