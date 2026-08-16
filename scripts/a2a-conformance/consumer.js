'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createA2aReplayStore } = require('./replay-store');
const { evaluateBoundedExchange } = require('./verifier');

const MAX_INPUT_BYTES = 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function sameResolvedPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readReceiverAuthority(authorityFile) {
  if (!authorityFile || !path.isAbsolute(authorityFile)) throw new Error('absolute receiver authority required');
  const resolved = path.resolve(authorityFile);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync.native(parent);
  const stat = fs.lstatSync(resolved);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameResolvedPath(parentReal, parent)
      || !stat.isFile() || stat.isSymbolicLink() || !sameResolvedPath(fs.realpathSync.native(resolved), resolved)
      || stat.size < 1 || stat.size > MAX_INPUT_BYTES) {
    throw new Error('receiver authority path is unsafe');
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size) throw new Error('receiver authority changed during read');
  return JSON.parse(bytes.toString('utf8'));
}

function main() {
  const replayDirectory = process.argv[2];
  const authorityFile = process.argv[3];
  if (!replayDirectory || !path.isAbsolute(replayDirectory)) return fail('absolute replay directory required');
  let authority;
  try { authority = readReceiverAuthority(authorityFile); } catch { return fail('valid receiver authority required'); }
  // Read the receiver-owned clock exactly once. The exchange payload cannot
  // select the time at which expiry/revocation is evaluated.
  const evaluationTime = authority.evaluationTime;
  const input = fs.readFileSync(0);
  if (input.length < 1 || input.length > MAX_INPUT_BYTES) return fail('bounded input required');
  let payload;
  try { payload = JSON.parse(input.toString('utf8')); } catch { return fail('valid JSON required'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',') !== 'requests'
      || !Array.isArray(payload.requests)) return fail('exact consumer payload required');

  const replay = createA2aReplayStore(replayDirectory);
  let effectCount = 0;
  const results = payload.requests.map((request) => evaluateBoundedExchange({
    request,
    authority,
    evaluationTime,
    replayReserve: replay.reserve,
    effect: () => Object.freeze({ performed: true, effectCount: ++effectCount }),
  }));
  process.stdout.write(`${JSON.stringify({ results, effectCount })}\n`);
}

main();
