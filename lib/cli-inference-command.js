'use strict';

const { runInference } = require('./cli-inference-runtime');
const { CLI_MUTATION_GATE } = require('./cli-mutation-gate');
function inferenceCommand(cli, args) {
  if (typeof args !== 'string' || Buffer.byteLength(args, 'utf8') > 262144) throw new TypeError('inference expects a JSON request up to 256 KiB');
  const result = runInference(cli.kernel, JSON.parse(args));
  const warning = cli.commitCliMutation('inference', CLI_MUTATION_GATE.inference);
  return JSON.stringify(warning ? { ...result, warning } : result);
}
module.exports = { inferenceCommand };
