'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const {
  runBenchmarks,
  VERSION,
  DEFAULT_SEED,
} = require('./bench-memory-scale');

const SCHEMA = 'axiom-memory-snapshot';

function getCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function buildSnapshot(opts) {
  const options = opts || {};
  const result = runBenchmarks(options);
  return {
    schema: SCHEMA,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    commit: getCommit(),
    iterations: result.iterations,
    seed: result.seed,
    fixtures: result.fixtures,
  };
}

function printHuman(snapshot) {
  const lines = [];
  lines.push('AXIOM memory snapshot');
  lines.push(`schema=${snapshot.schema} version=${snapshot.version}`);
  lines.push(`commit=${snapshot.commit} generatedAt=${snapshot.generatedAt}`);
  lines.push(`iterations=${snapshot.iterations} seed=0x${snapshot.seed.toString(16)}`);
  for (const [, data] of Object.entries(snapshot.fixtures)) {
    lines.push(
      `[${data.name}] size=${data.size} recordCount=${data.recordCount} ` +
      `ingest=${data.ingestMs}ms query=${data.queryMs}ms roundtrip=${data.roundtripMs}ms`
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.split('=')[1] : null;
  const iterationsArg = args.find((a) => a.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : 3;
  const snapshot = buildSnapshot({ iterations });
  const jsonStr = JSON.stringify(snapshot, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, jsonStr + '\n', 'utf8');
    process.stdout.write(`Snapshot written to ${outputPath}\n`);
  } else if (json) {
    process.stdout.write(`${jsonStr}\n`);
  } else {
    printHuman(snapshot);
  }
}

module.exports = {
  SCHEMA,
  VERSION,
  DEFAULT_SEED,
  buildSnapshot,
  printHuman,
  getCommit,
};
