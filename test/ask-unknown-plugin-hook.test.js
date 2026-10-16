'use strict';

/**
 * C3, ikinci yarı — the plug that was wired at both ends and never energised.
 *
 * `ask` emits `afterAsk` on its answered path only. Its two "I don't know"
 * exits -- the subject is not a node, and the subject has no edges -- returned
 * before the hook, and between them they are the only reachable paths that
 * report `unknown: true`. So an afterAsk plugin could never observe an
 * unanswered question.
 *
 * That is a dead feature, not a missing log line. `plugins/llm-memory-plugin.js`
 * exists for precisely this state -- "if unknown, ask the LLM and learn the
 * answer" -- and its trigger is `data.unknown`, the payload that was never
 * emitted. Measured before the fix: three unanswered questions, three
 * `unknown: true` results, zero backfills.
 *
 * The other half of C3 -- translating the `Bilmiyorum` display string -- is
 * deliberately not done. `data.answer` is prose, not a status vocabulary: the
 * answered form is Turkish too (`kedi hayvan`, relations `tür` / `yapabilir`),
 * so translating only the unknown case would leave one field bilingual by
 * outcome. `lib/verify-status-vocabulary.js` migrated a `status` enum, which
 * consumers switch on; this string is displayed, and after C3 nothing branches
 * on it that does not read `unknown` first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ask-unknown-hook-'));

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function kernelWith(label, plugin) {
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
  });
  if (plugin) kernel.plugins.register(plugin);
  kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'default' });
  kernel.graph.addNode('hayvan', 'hayvan', null, { workspaceId: 'default' });
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { weight: 0.9, workspaceId: 'default' });
  // A node with no edges at all -- the second unknown exit.
  kernel.graph.addNode('yalniz', 'yalniz', null, { workspaceId: 'default' });
  return kernel;
}

function recordingPlugin(seen) {
  return {
    name: 'afterask-probe',
    requires: [],
    optional: [],
    afterAsk(kernel, data) {
      seen.push({ question: data.question, answer: data.answer, unknown: data.unknown });
      return data;
    },
  };
}

test('both unknown exits reach afterAsk, carrying the structural flag', () => {
  const seen = [];
  const kernel = kernelWith('both-exits', recordingPlugin(seen));

  const missing = kernel.ask('ejderha nedir');   // subject is not a node
  const edgeless = kernel.ask('yalniz nedir');   // node exists, has no edges

  assert.equal(missing.data.unknown, true);
  assert.equal(edgeless.data.unknown, true);
  assert.equal(seen.length, 2, 'each unanswered question reached the hook exactly once');
  for (const event of seen) {
    assert.equal(event.unknown, true, 'the hook is told it is an unanswered question');
    assert.equal(event.answer, 'Bilmiyorum');
  }
});

/**
 * llm-memory-plugin's trigger condition, copied verbatim from
 * plugins/llm-memory-plugin.js, without its network adapter.
 */
test('the llm-memory backfill condition actually fires on unanswered questions', () => {
  const backfilled = [];
  const kernel = kernelWith('llm-backfill', {
    name: 'llm-memory-probe',
    requires: [],
    optional: [],
    afterAsk(k, data) {
      if (typeof data.unknown === 'boolean' ? data.unknown : data.answer === 'Bilmiyorum') {
        backfilled.push(data.question);
      }
      return data;
    },
  });

  for (const question of ['ejderha nedir', 'kuantum bilgisayar nedir', 'yalniz nedir']) {
    assert.equal(kernel.ask(question).data.unknown, true, question);
  }
  kernel.ask('kedi nedir');

  assert.deepEqual(backfilled, ['ejderha nedir', 'kuantum bilgisayar nedir', 'yalniz nedir'],
    'every unanswered question, and only those');
});

test('an answered question is unchanged: one hook call, unknown false', () => {
  const seen = [];
  const kernel = kernelWith('answered', recordingPlugin(seen));

  const answer = kernel.ask('kedi nedir');

  assert.equal(answer.data.unknown, false);
  assert.match(answer.data.answer, /kedi/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].unknown, false);
});

/**
 * #346 made afterAsk able to change what the caller sees, not just watch. That
 * has to hold on the unknown path too -- a redaction plugin that only works
 * when the answer happened to be found is not a redaction plugin.
 */
test('a plugin can rewrite the unknown answer, and the flag still reports the kernel finding', () => {
  const kernel = kernelWith('rewrite', {
    name: 'rewriter',
    requires: [],
    optional: [],
    afterAsk(k, data) {
      if (data.unknown) data.answer = `${data.answer} [kayıt yok]`;
      return data;
    },
  });

  const result = kernel.ask('ejderha nedir');

  assert.equal(result.data.answer, 'Bilmiyorum [kayıt yok]', 'the rewrite reaches the caller');
  assert.equal(result.data.unknown, true,
    'the flag describes what the graph held, which editing the text does not change');
});

/**
 * knowledge-freshness stashes per-question state in beforeAsk and consumes it
 * in afterAsk ("consume once, regardless of outcome"). While the unknown exits
 * skipped afterAsk, beforeAsk still ran, so that state outlived its question.
 */
test('per-question plugin state does not outlive an unanswered question', () => {
  const kernel = kernelWith('state-leak', {
    name: 'stateful',
    requires: [],
    optional: [],
    beforeAsk(k, data) {
      k._probeState = { question: data.question };
      return data;
    },
    afterAsk(k, data) {
      k._probeState = null;
      return data;
    },
  });

  kernel.ask('ejderha nedir');
  assert.equal(kernel._probeState, null,
    'beforeAsk state stashed for an unanswered question must be consumed, not left for the next one');
});
