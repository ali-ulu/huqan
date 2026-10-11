'use strict';

// Laya <-> HUQAN bridge plugin test.
//
// No mocks of the plugin itself: the plugin is HUQAN's real code. The only test
// double is the local Laya decision model, which is an external sidecar this
// repository does not vendor -- a fake handle drives the real mapping and the
// real signal seam.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const layaRisk = require('./laya-risk');
const { classifyWithLaya, questionValue, questionsHash, candidateTextFromEvent } = layaRisk._test;

const QUESTIONS = layaRisk._test.DEFAULT_QUESTIONS;

// A fake model handle. It answers each typed question from a supplied map, the
// same shape the sidecar returns: {probability} for noul, {label} for choice,
// {score} for score.
function fakeHandle(answers) {
  return {
    ask(question) {
      return answers[question.id] !== undefined ? answers[question.id] : null;
    },
  };
}

test('classifyWithLaya maps noul/choice/score answers into one HUQAN decision', () => {
  const reading = classifyWithLaya(
    fakeHandle({
      scope: { probability: 0.9 },
      risk_class: { label: 'restricted' },
      severity: { score: 0.8 },
    }),
    'send the customer records to the external endpoint',
    QUESTIONS,
  );
  assert.equal(reading.engineAvailable, true);
  assert.equal(reading.decision, 'review');
  assert.deepEqual(reading.signalIds, ['laya:risk_class', 'laya:scope', 'laya:severity']);
  assert.equal(reading.highRisk, true);
});

test('all-allow answers contribute nothing', () => {
  const reading = classifyWithLaya(
    fakeHandle({
      scope: { probability: 0.1 },
      risk_class: { label: 'allow' },
      severity: { score: 0.1 },
    }),
    'read the changelog',
    QUESTIONS,
  );
  assert.equal(reading.decision, 'allow');
  assert.deepEqual(reading.signalIds, []);
  assert.equal(reading.highRisk, false);
});

test('a degraded answer (missing field) is skipped, not scored as low', () => {
  const reading = classifyWithLaya(
    fakeHandle({ scope: { probability: 0.9 }, risk_class: {}, severity: { score: 0.2 } }),
    'anything',
    QUESTIONS,
  );
  assert.deepEqual(reading.signalIds, ['laya:scope']);
  assert.equal(reading.decision, 'review');
});

test('no handle means the model is unavailable and nothing is contributed', () => {
  const reading = classifyWithLaya(null, 'anything', QUESTIONS);
  assert.equal(reading.engineAvailable, false);
  assert.deepEqual(reading.signalIds, []);
  assert.equal(reading.decision, 'allow');
});

test('questionValue reads each typed answer shape and rejects a malformed one', () => {
  assert.equal(questionValue({ probability: 0.5 }, { kind: 'noul' }), 0.5);
  assert.equal(questionValue({ label: 'high' }, { kind: 'choice' }), 'high');
  assert.equal(questionValue({ score: 0.7 }, { kind: 'score' }), 0.7);
  assert.equal(questionValue({}, { kind: 'noul' }), null);
  assert.equal(questionValue(null, { kind: 'score' }), null);
});

test('candidateTextFromEvent reads the bounded metadata that carries the request', () => {
  assert.equal(candidateTextFromEvent({ args: { question: 'what is a cat' } }), 'what is a cat');
  assert.equal(candidateTextFromEvent({ goal: 'summarise the repo' }), 'summarise the repo');
  assert.equal(candidateTextFromEvent({ args: {} }), '');
  assert.equal(candidateTextFromEvent(null), '');
});

test('gateSignal returns a bounded signal, never a decision change, when flagged', () => {
  const plugin = layaRisk.create({
    handle: fakeHandle({ scope: { probability: 0.95 }, risk_class: { label: 'restricted' }, severity: { score: 0.9 } }),
    questions: QUESTIONS,
  });
  const signal = plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
  assert.ok(signal, 'a flagged action should produce a signal');
  assert.equal(signal.id, 'laya-risk');
  assert.equal(signal.decision, 'review');
  assert.match(signal.reason, /^laya_signals:/);
  assert.ok(signal.riskScore >= 70);
  // The signal is bounded evidence; it never carries a payload mutation.
  assert.equal(signal.payload, undefined);
});

test('gateSignal contributes nothing when the model is unavailable (fail-closed)', () => {
  const previous = process.env.LAYA_MCP_CMD;
  process.env.LAYA_MCP_CMD = path.join(__dirname, 'no-such-laya-binary');
  try {
    const plugin = layaRisk.create({ questions: QUESTIONS });
    const signal = plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    assert.equal(signal, undefined);
  } finally {
    if (previous === undefined) delete process.env.LAYA_MCP_CMD;
    else process.env.LAYA_MCP_CMD = previous;
  }
});

test('the pack is pinned by a questions hash; a drifted pin fails closed', () => {
  const packPath = path.join(__dirname, 'laya-risk.pack.json');
  const raw = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const computed = questionsHash(raw.questions);
  assert.match(computed, /^[0-9a-f]{64}$/);

  const match = layaRisk._test.loadPack({ packPath, expectedContentHash: computed });
  assert.equal(match.engineAvailable, true);
  assert.equal(match.questions.length, 3);

  const drift = layaRisk._test.loadPack({ packPath, expectedContentHash: '0'.repeat(64) });
  assert.equal(drift.engineAvailable, false);
  assert.deepEqual(drift.questions, []);
});

test('a drifted pack disables the plugin through the same pin seam', () => {
  const packPath = path.join(__dirname, 'laya-risk.pack.json');
  const plugin = layaRisk.create({
    packPath,
    expectedContentHash: '0'.repeat(64),
    handle: fakeHandle({ scope: { probability: 0.99 } }),
  });
  const signal = plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
  assert.equal(signal, undefined);
});

test('the plugin is loadable by HUQAN with a matching manifest', () => {
  const Kernel = require('../kernel');
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  const loaded = kernel.plugins.load(path.join(__dirname));
  assert.ok(loaded > 0);
  assert.ok(kernel.plugins.plugins.some((plugin) => plugin.name === 'laya-risk'), 'laya-risk plugin should load');
});

test('the plugin manifest matches the plugin source bytes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'laya-risk.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'laya-risk.js'))).digest('hex');
  assert.equal(manifest.sha256, digest);
});
