'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const classifierTarget = path.resolve(__dirname, '../lib/a2a/exchange-error-record.js');
const classifierNeedle = 'return classifyEvaluatorReason(errorType);';
const depthTarget = path.resolve(__dirname, '../lib/a2a/delegation-depth.js');
const depthNeedle = 'const MAX_DELEGATION_DEPTH = 16;';

const mutant = process.env.HUQAN_A2A_ERROR_MUTANT;
if (mutant === 'classifier-force-true' || mutant === 'depth-bound-removed') {
  const originalLoader = Module._extensions['.js'];
  Module._extensions['.js'] = function load(module, filename) {
    if (mutant === 'classifier-force-true' && filename === classifierTarget) {
      const source = fs.readFileSync(filename, 'utf8');
      if (!source.includes(classifierNeedle)) throw new Error('mutation_target_missing');
      module._compile(source.replace(classifierNeedle, 'return true;'), filename);
      return;
    }
    if (mutant === 'depth-bound-removed' && filename === depthTarget) {
      const source = fs.readFileSync(filename, 'utf8');
      if (!source.includes(depthNeedle)) throw new Error('mutation_target_missing');
      module._compile(source.replace(depthNeedle, 'const MAX_DELEGATION_DEPTH = 1000000;'), filename);
      return;
    }
    return originalLoader(module, filename);
  };
}

function main() {
  const patterns = {
    'classifier-force-true': 'unknown error types never enter',
    'depth-bound-removed': 'out of bounds',
  };
  const results = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    const args = ['--require', __filename, '--test', '--test-name-pattern', pattern,
      path.resolve(__dirname, '../test/a2a-exchange-error-depth.test.js')];
    const run = value => spawnSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HUQAN_A2A_ERROR_MUTANT: value },
    });
    const baseline = run('');
    const mutated = run(name);
    const killed = baseline.status === 0 && mutated.status === 1;
    results.push({ mutation: name, baselineExit: baseline.status, mutantExit: mutated.status, killed });
    if (!killed) {
      process.stderr.write(`${baseline.stdout || ''}${baseline.stderr || ''}${mutated.stdout || ''}${mutated.stderr || ''}`);
    }
  }
  console.log(JSON.stringify(results));
  if (!results.every((result) => result.killed)) process.exitCode = 1;
}

if (require.main === module) main();
