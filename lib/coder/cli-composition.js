'use strict';

const { createCliCommandHandlers: createHandlers } = require('../cli-command-handlers');
const coderLoop = require('./fix-loop');
const { produceProject, produceProjectRevision } = require('./project-producer');
const { initializeProject } = require('./project-initialization');
const { loadProjectMethods, rememberProjectMethods, prepareProjectMemoryOutput } = require('./project-method-memory');
const { rememberCandidate, resolveCandidate, selectCandidate } = require('./learned-candidate');
const { runArithmeticSynthesis, formatSynthesisText } = require('./arithmetic-synthesis');
const { readRequirements } = require('../cli-coder-requirements');
const { parseRequirements, MAX_REQUIREMENTS_BYTES } = require('./requirements-parser');

// The application layer supplies the loop to the inner CLI boundary.
function createCliCommandHandlers(collaborators) {
  return createHandlers({ ...collaborators, coderLoop: { ...coderLoop, produceProject, produceProjectRevision, initializeProject, loadProjectMethods,
    readProjectRequirements: file => readRequirements(file, { parseRequirements, maxBytes: MAX_REQUIREMENTS_BYTES }),
    rememberProjectMethods, prepareProjectMemoryOutput,
    rememberCandidate, resolveCandidate, selectCandidate, runArithmeticSynthesis, formatSynthesisText } });
}

module.exports = { createCliCommandHandlers };
