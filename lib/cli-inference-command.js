'use strict';

const { runInference } = require('./cli-inference-runtime');
const { classify } = require('./cli-mutation-gate');
function inferenceCommand(cli, args) {
  if (typeof args !== 'string' || Buffer.byteLength(args, 'utf8') > 262144) throw new TypeError('inference expects a JSON request up to 256 KiB');
  const result = runInference(cli.kernel, JSON.parse(args));
  const { classification } = classify('inference', args);
  const warning = classification.mutationType === 'none' ? null : cli.commitCliMutation('inference', classification);
  return JSON.stringify(warning ? { ...result, warning } : result);
}
module.exports = { inferenceCommand };
