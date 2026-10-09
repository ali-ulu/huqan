'use strict';

const { createCliCommandHandlers: createHandlers } = require('../cli-command-handlers');
const coderLoop = require('./fix-loop');
const { produceProject } = require('./project-producer');
const { initializeProject } = require('./project-initialization');
const { rememberCandidate, resolveCandidate } = require('./learned-candidate');

// The application layer supplies the loop to the inner CLI boundary.
function createCliCommandHandlers(collaborators) {
  return createHandlers({ ...collaborators, coderLoop: { ...coderLoop, produceProject, initializeProject,
    rememberCandidate, resolveCandidate } });
}

module.exports = { createCliCommandHandlers };
