'use strict';

/**
 * #4034: `npm run verify` reported a passing `tests` stage as
 * `spawn error: spawnSync npm ENOBUFS`.
 *
 * `runStage` handed spawnSync no `maxBuffer`, so it captured at Node's 1 MiB
 * default. `npm test` emits ~1.16 MiB, the capture overflowed, and the stage
 * was classified as abnormal -- a false negative in the verification path
 * itself, and an unusable `output` field for the one stage an operator most
 * needs to read.
 *
 * The stub stages below emit more than the default buffer on purpose. A single
 * large `process.stdout.write` does NOT reproduce the overflow (spawnSync
 * silently truncates it), so the writer is chunked and drain-aware: that is the
 * shape that produces ENOBUFS, and the shape a real `npm test` has.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { runStage, renderSummary, STAGE_OUTPUT_LIMIT_BYTES } = require('../scripts/verify-suite');

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/**
 * Source for a child that writes `bytes` to stdout in drain-aware chunks and
 * then exits 0, so only the capture ceiling can make it look abnormal.
 */
function emitBytesSource(bytes) {
  return [
    `const total = ${bytes};`,
    `const chunk = 'x'.repeat(${CHUNK_BYTES});`,
    'let written = 0;',
    'function pump() {',
    '  while (written < total) {',
    '    if (!process.stdout.write(chunk)) {',
    '      process.stdout.once(\'drain\', pump);',
    '      return;',
    '    }',
    '    written += chunk.length;',
    '  }',
    '  process.exit(0);',
    '}',
    'pump();',
  ].join('\n');
}

const stageEmitting = (bytes) => ({
  name: 'stub',
  command: [process.execPath, '-e', emitBytesSource(bytes)],
});

test('a stage whose output exceeds the spawnSync default is still reported as passing', () => {
  const stage = stageEmitting(DEFAULT_MAX_BUFFER_BYTES + 200 * 1024);
  const result = runStage(stage);
  assert.equal(result.abnormal, null, 'a stage inside the configured ceiling is not abnormal');
  assert.equal(result.ok, true, 'the stage exited 0, so it passed');
  assert.ok(
    result.output.length > DEFAULT_MAX_BUFFER_BYTES,
    'the full output is captured, not truncated at the spawnSync default',
  );
});

test('a stage that exceeds the configured ceiling reports the overflow, not a spawn error', () => {
  const stage = stageEmitting(STAGE_OUTPUT_LIMIT_BYTES + 4 * 1024 * 1024);
  const result = runStage(stage);
  assert.equal(result.ok, false, 'a capture overflow cannot be reported as a pass');
  assert.match(result.abnormal, /output limit exceeded/);
  assert.match(result.abnormal, new RegExp(String(STAGE_OUTPUT_LIMIT_BYTES)));
  assert.doesNotMatch(result.abnormal, /spawn error/, 'an overflow is not a generic spawn failure');
});

test('renderSummary names the overflow so an operator can tell it from a failing checker', () => {
  const stage = stageEmitting(STAGE_OUTPUT_LIMIT_BYTES + 4 * 1024 * 1024);
  const result = runStage(stage);
  const summary = renderSummary([result], [stage]);
  assert.match(summary, /FAIL stub \(\d+\.\d+s, output limit exceeded/);
});
