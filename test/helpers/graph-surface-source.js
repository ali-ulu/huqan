'use strict';

// #3101: Graph's methods live in graph.js and in the method-group holders it
// installs (lib/graph-*-methods.js). A source contract about "Graph" has to
// read all of them: a one-line-delegation check must find a method that moved
// into a holder, and a "must not define or alias" check must not go vacuous
// because the name could now hide in a holder. The holder list is derived
// from graph.js's own requires, so a new holder is read without editing this.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function graphMethodHolders() {
  const holders = [...read('graph.js').matchAll(/require\('\.\/(lib\/graph-[a-z-]+-methods)'\)/g)]
    .map((match) => `${match[1]}.js`);
  return [...new Set(holders)].sort();
}

function readGraphSurfaceSource() {
  return [read('graph.js'), ...graphMethodHolders().map(read)].join('\n');
}

module.exports = { graphMethodHolders, readGraphSurfaceSource };
