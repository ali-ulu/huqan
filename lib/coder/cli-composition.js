'use strict';

const { createCliCommandHandlers: createHandlers } = require('../cli-command-handlers');
const coderLoop = require('./fix-loop');

// The application layer supplies the loop to the inner CLI boundary.
function createCliCommandHandlers(collaborators) {
  return createHandlers({ ...collaborators, coderLoop });
}

module.exports = { createCliCommandHandlers };
