'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadSemanticModel } = require('../lib/semantic-model-inference');

// Fixed calibration pairs only: the frozen R50 evaluation corpus is never measured here.
function main() {
  const dataset = require('../test/fixtures/semantic-training-v1/training-dataset.json');
  const pairs = dataset.records.filter(record => record.split === 'calibration' && !record.needsReview);
  assert.ok(pairs.length > 0, 'calibration pairs required');
  const results = [];
  for (const family of ['ssm', 'rwkv', 'mamba', 'transformer']) {
    const bytes = fs.readFileSync(path.join(__dirname, '../lib/semantic-model-artifacts', `${family}.json`));
    assert.ok(bytes.length <= 10 * 1024 * 1024, 'artifact exceeds 10 MiB');
    const model = loadSemanticModel(bytes.toString('utf8'));
    for (let i = 0; i < 100; i++) model.predict(pairs[i % pairs.length]);
    const wall = [];
    const cpu = [];
    const batchStart = process.cpuUsage();
    for (let i = 0; i < 1000; i++) {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      model.predict(pairs[i % pairs.length]);
      wall.push(performance.now() - start);
      const elapsed = process.cpuUsage(cpuStart);
      cpu.push((elapsed.user + elapsed.system) / 1000);
    }
    const batch = process.cpuUsage(batchStart);
    wall.sort((a, b) => a - b);
    cpu.sort((a, b) => a - b);
    const result = { family, artifactDigest: model.artifactDigest, bytes: bytes.length,
      samples: 1000, warmup: 100, wallP95Ms: wall[949], cpuP95Ms: cpu[949],
      batchCpuMeanMs: (batch.user + batch.system) / 1000000,
      cpuP95Verified: process.platform !== 'win32' };
    results.push(result);
    console.log(JSON.stringify(result));
    // Windows CPU counters are quantized; preserve their raw result without claiming a p95 proof.
    assert.ok(result.wallP95Ms <= 5, `${family}: wall p95 exceeds 5 ms`);
    if (result.cpuP95Verified) assert.ok(result.cpuP95Ms <= 5, `${family}: CPU p95 exceeds 5 ms`);
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, results }, null, 2));
}

if (require.main === module) main();
module.exports = { main };
