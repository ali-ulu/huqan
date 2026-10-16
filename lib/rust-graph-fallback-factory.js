'use strict';

const Graph = require('../graph');

function createRustGraphFallback(options = {}) {
  return new Graph({ memoryPath: options.memoryPath || 'memory.json' });
}

module.exports = { createRustGraphFallback };
