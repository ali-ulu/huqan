'use strict';

const { createCliCommandHandlers: createHandlers } = require('../cli-command-handlers');
const coderLoop = require('./fix-loop');
const { produceProject, produceProjectRevision } = require('./project-producer');
const { initializeProject } = require('./project-initialization');
const { rememberCandidate, resolveCandidate, selectCandidate } = require('./learned-candidate');
const { runArithmeticSynthesis, formatSynthesisText } = require('./arithmetic-synthesis');

// The application layer supplies the loop to the inner CLI boundary.
function createCliCommandHandlers(collaborators) {
  return createHandlers({ ...collaborators, coderLoop: { ...coderLoop, produceProject, produceProjectRevision, initializeProject,
    rememberCandidate, resolveCandidate, selectCandidate, runArithmeticSynthesis, formatSynthesisText } });
}

module.exports = { createCliCommandHandlers };
