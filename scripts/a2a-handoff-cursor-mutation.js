'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const target = path.resolve(__dirname, '../lib/a2a/handoff-termination.js');
const needle = "closedBy === CLOSED_BY.HUMAN";

if (process.env.HUQAN_A2A_CURSOR_MUTANT === 'termination-collapse') {
  const originalLoader = Module._extensions['.js'];
  Module._extensions['.js'] = function load(module, filename) {
    if (filename !== target) return originalLoader(module, filename);
    const source = fs.readFileSync(filename, 'utf8');
    if (!source.includes(needle)) throw new Error('mutation_target_missing');
    module._compile(source.replace(needle, 'false'), filename);
  };
}

function main() {
  const args = ['--require', __filename, '--test', '--test-name-pattern', 'separate termination reasons',
    path.resolve(__dirname, '../test/a2a-handoff-cursor.test.js')];
  const run = mutant => spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HUQAN_A2A_CURSOR_MUTANT: mutant },
  });
  const baseline = run('');
  const mutant = run('termination-collapse');
  const killed = baseline.status === 0 && mutant.status === 1
    && /not ok \d+ - human and target/.test(mutant.stdout || '');
  console.log(JSON.stringify({ baselineExit: baseline.status, mutantExit: mutant.status,
    mutation: 'termination-collapse', killed }));
  if (!killed) {
    process.stderr.write(`${baseline.stdout || ''}${baseline.stderr || ''}${mutant.stdout || ''}${mutant.stderr || ''}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
