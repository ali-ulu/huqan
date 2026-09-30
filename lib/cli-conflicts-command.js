'use strict';

// The `conflicts` CLI handler (#3187), the command-table row for the review
// flow in lib/cli-conflicts.js. Kept separate from that module for the same
// reason cli-agent-commands.js is separate from cli-hypotheses.js: the command
// table wires the mutation gate, the review logic does not know about it.

const { runCliConflicts } = require('./cli-conflicts');
const { CLI_MUTATION_GATE } = require('./cli-mutation-gate');

function conflictsCommand(cli, args, opts, command) {
  const argsObject = args && typeof args === 'object' ? args : {};
  return runCliConflicts(cli.kernel, argsObject, {
    json: opts.json === true,
    commitMutation: argsObject.review === true
      ? () => cli.commitCliMutation('conflicts', CLI_MUTATION_GATE.conflicts)
      : null,
  });
}

module.exports = { conflictsCommand };
