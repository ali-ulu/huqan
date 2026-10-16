'use strict';

/**
 * #3041: the Rust `ask` path ranks out-edges by weight and concatenates them.
 * It runs none of the JS verify phases (numeric, negation, PREVENTS, type
 * lattice), so it is fast but unverified. This pins the honest half of the fix:
 * every Rust `ask` reply is marked `verified: false` /
 * `verification: 'naive-lookup'`, and that marker survives the bridge up to the
 * caller instead of being flattened into a bare answer string.
 *
 * If the Rust binary is absent these skip rather than pretend to pass.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'huqan-core', 'target', 'release', 'huqan-core');
const skip = fs.existsSync(BIN) ? false : 'huqan-core release binary not built';

function rustExec(commands) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`huqan-core exit ${code}: ${stderr}`));
      resolve(stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    });
    proc.stdin.end(commands.map(command => JSON.stringify(command)).join('\n'));
  });
}

describe('#3041 Rust ask reports itself as an unverified lookup', { skip }, () => {
  it('an answered question carries verified:false and the naive-lookup marker', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'elma', label: 'elma' },
      { cmd: 'add_node', id: 'meyve', label: 'meyve' },
      { cmd: 'add_edge', from: 'elma', to: 'meyve', relation: 'tür' },
      { cmd: 'ask', question: 'elma nedir' },
    ]);
    const answer = res[3];
    assert.strictEqual(answer.ok, true);
    assert.ok(answer.answer.startsWith('elma'));
    assert.strictEqual(answer.verified, false, 'the naive lookup must not claim verification');
    assert.strictEqual(answer.verification, 'naive-lookup');
    assert.deepStrictEqual(answer.verificationPhases, [], 'no verify phase ran');
  });

  it('an unknown question is also marked, with unknown:true', async () => {
    const res = await rustExec([{ cmd: 'ask', question: 'bilinmeyen nedir' }]);
    const answer = res[0];
    assert.strictEqual(answer.ok, true);
    assert.strictEqual(answer.answer, 'Bilmiyorum');
    assert.strictEqual(answer.unknown, true);
    assert.strictEqual(answer.verified, false);
    assert.strictEqual(answer.verification, 'naive-lookup');
  });

  it('a batch of asks keeps the marker on every reply', async () => {
    const res = await rustExec([{
      cmd: 'batch',
      commands: [
        { cmd: 'add_node', id: 'kedi', label: 'kedi' },
        { cmd: 'add_node', id: 'hayvan', label: 'hayvan' },
        { cmd: 'add_edge', from: 'kedi', to: 'hayvan', relation: 'tür' },
        { cmd: 'ask', question: 'kedi nedir' },
        { cmd: 'ask', question: 'yok nedir' },
      ],
    }]);
    const results = res[0].results;
    const asks = results.filter(r => typeof r.answer === 'string');
    assert.equal(asks.length, 2);
    for (const ask of asks) {
      assert.strictEqual(ask.verified, false);
      assert.strictEqual(ask.verification, 'naive-lookup');
    }
  });
});

describe('#3041 the bridge carries the marker to the caller', () => {
  const { runRustSandbox, runRustSandboxResult } = require('../lib/reason-sandbox');

  function fakeRustGraph(replies) {
    return {
      sent: [],
      async send(command) {
        this.sent.push(command);
        return {
          ok: true,
          results: (command.commands || []).map((c, i) => replies[i]),
        };
      },
      async learnBatch() { return { ok: true }; },
      destroy() {},
    };
  }

  it('runRustSandboxResult keeps verified/verification per answer', async () => {
    const graph = fakeRustGraph([
      { answer: 'elma meyve', subject: 'elma', unknown: false, verified: false, verification: 'naive-lookup' },
    ]);
    const result = await runRustSandboxResult({ ask: ['elma nedir'], createRustGraph: () => graph });
    assert.deepStrictEqual(result.answers, ['elma meyve']);
    assert.equal(result.details[0].verified, false);
    assert.equal(result.details[0].verification, 'naive-lookup');
  });

  it('runRustSandbox still resolves to the plain string array', async () => {
    const graph = fakeRustGraph([
      { answer: 'elma meyve', subject: 'elma', unknown: false, verified: false, verification: 'naive-lookup' },
    ]);
    const answers = await runRustSandbox({ ask: ['elma nedir'], createRustGraph: () => graph });
    assert.deepStrictEqual(answers, ['elma meyve']);
  });
});

