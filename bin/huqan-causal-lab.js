#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { runCausalExperiment } = require('../lib/cognitive-lab-causal-experiment');
const { contentHash } = require('../lib/content-hash');
const design = require('../fixtures/cognitive-lab/causal-confirmatory-design.json');
const dataset = require('../fixtures/cognitive-lab/causal-confirmatory-fixture.json');

function main(args) {
  if (args.length === 1 && args[0] === '--help') return { usage: 'huqan-causal-lab --source-commit <40-character Git SHA> --source-dirty <true|false>', scope: design.scope };
  if (args.length !== 4 || args[0] !== '--source-commit' || !/^[a-f0-9]{40}$/.test(args[1]) || args[2] !== '--source-dirty' || !['true', 'false'].includes(args[3])) throw new TypeError('explicit --source-commit <40-character Git SHA> --source-dirty <true|false> required');
  // Git converts line endings on Windows. The frozen law hashes normalized
  // UTF-8 source, while sourceFileHashes below report actual installed bytes.
  const worldSource = fs.readFileSync(path.join(__dirname, '..', 'lib/cognitive-lab-causal-world.js'), 'utf8').replace(/\r\n/g, '\n');
  if (contentHash(worldSource) !== design.worldDigest) throw new Error('frozen environment law digest mismatch');
  const root = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(root, 'huqan-causal-lab-'));
  if (path.dirname(scratch) !== root || !path.basename(scratch).startsWith('huqan-causal-lab-')) throw new Error('invalid private experiment path');
  let graph;
  try {
    graph = new Graph({ useSQLite: true, memoryPath: path.join(scratch, 'memory.json'), dbPath: path.join(scratch, 'memory.db') });
    const journal = createExperienceJournal();
    const result = runCausalExperiment({ graph, journal, createSimulator: (store, options) => new CausalSimulator(store, options), design, dataset, sourceCommit: args[1], sourceDirty: args[3] === 'true' });
    const files = ['causalSimulator.js', 'lib/causal/causal-episode-contract.js', 'lib/causal/learned-causal-engine.js', 'lib/causal/causal-runtime.js',
      'lib/cognitive-lab-causal-world.js', 'lib/cognitive-lab-causal-experiment.js', 'fixtures/cognitive-lab/causal-confirmatory-design.json', 'fixtures/cognitive-lab/causal-confirmatory-fixture.json'];
    return { ...result, sourceEvidence: 'CALLER_DECLARED_GIT_SHA_WITH_MEASURED_FILE_HASHES',
      sourceFileHashes: Object.fromEntries(files.map(file => [file, contentHash(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))])) };
  } finally {
    try { if (graph) graph.closeSqlite(); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
}
if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (['REJECT', 'INSUFFICIENT'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
module.exports = { main };
