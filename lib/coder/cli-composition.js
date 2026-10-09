'use strict';

const { createCliCommandHandlers: createHandlers } = require('../cli-command-handlers');
const coderLoop = require('./fix-loop');
const { produceProject } = require('./project-producer');
const { initializeProject } = require('./project-initialization');

// The application layer supplies the loop to the inner CLI boundary.
function createCliCommandHandlers(collaborators) {
  return createHandlers({ ...collaborators, coderLoop: { ...coderLoop, produceProject, initializeProject } });
}

module.exports = { createCliCommandHandlers };
