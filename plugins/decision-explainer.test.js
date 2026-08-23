'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('./decision-explainer');

test('explainDecision: known MCP gate reason codes get a fixed Turkish sentence', () => {
  assert.equal(
    plugin.explainDecision({ decision: 'allow', reason: 'read_only_allow' }),
    'İzin verildi: Salt-okunur bir işlem olduğu için izin verildi.',
  );
  assert.equal(
    plugin.explainDecision({ decision: 'review', reason: 'ab2_tool_call_gate_blocked' }),
    "Review'a alındı: AB2 araç çağrısı kapısı (ör. gizli anahtar/parola içeriği) nedeniyle engellendi.",
  );
  assert.equal(
    plugin.explainDecision({ decision: 'dry_run_only', reason: 'agent_loop_dry_run_only' }),
    'Yalnızca kuru-çalıştırma (dry-run) izinli: Ajan döngüsü yalnızca kuru-çalıştırma (dry-run) modunda izinli.',
  );
  assert.equal(
    plugin.explainDecision({ decision: 'block', reason: 'unknown_tool_blocked' }),
    'Engellendi: Bilinmeyen bir araç çağrıldığı için engellendi.',
  );
});

test('explainDecision: unknown/free-text reasons fall back to a generic template', () => {
  assert.equal(
    plugin.explainDecision({ decision: 'review', reason: 'Memory admission requires review' }),
    "Karar: review'a alındı. Sebep: Memory admission requires review",
  );
});

test('explainDecision: missing reason still names the decision', () => {
  assert.equal(plugin.explainDecision({ decision: 'quarantine' }), 'Karar: karantinaya alındı.');
});

test('explainDecision: canonical verdict envelope (.verdict) is also accepted', () => {
  assert.equal(
    plugin.explainDecision({ verdict: 'block', reason: 'unknown_tool_blocked' }),
    'Engellendi: Bilinmeyen bir araç çağrıldığı için engellendi.',
  );
});

test('explainDecision: a caller-supplied Object.prototype member name does not leak into the explanation (#1319)', () => {
  // Object.freeze() does not cut the prototype chain, so a plain
  // `table[key]` lookup for these caller-controlled key names used to
  // return the inherited Object.prototype member (a function) instead of
  // falling back, embedding the function's source in the human-readable
  // explanation text.
  assert.equal(
    plugin.explainDecision({ decision: 'allow', reason: 'constructor' }),
    "Karar: izin verildi. Sebep: constructor",
  );
  assert.equal(
    plugin.explainDecision({ decision: 'allow', reason: 'toString' }),
    "Karar: izin verildi. Sebep: toString",
  );
  assert.equal(
    plugin.explainDecision({ decision: 'toString', reason: 'read_only_allow' }),
    'toString: Salt-okunur bir işlem olduğu için izin verildi.',
  );
  const valueOfExplanation = plugin.explainDecision({ decision: 'valueOf', reason: 'valueOf' });
  assert.equal(typeof valueOfExplanation, 'string');
  assert.equal(/\[native code\]/.test(valueOfExplanation), false);
});

test('explainDecision: malformed/missing decision returns a safe fallback', () => {
  assert.equal(
    plugin.explainDecision(null),
    'Açıklanacak bir karar bulunamadı (decision/verdict alanı eksik).',
  );
  assert.equal(
    plugin.explainDecision({}),
    'Açıklanacak bir karar bulunamadı (decision/verdict alanı eksik).',
  );
});

test('capability run(): explain wraps explainDecision in the standard plugin envelope', async () => {
  const result = await plugin.run(null, { decision: { decision: 'allow', reason: 'read_only_allow' } });
  assert.equal(result.ok, true);
  assert.equal(result.plugin, 'decision-explainer');
  assert.equal(result.capability, 'explain');
  assert.equal(result.data.explanation, 'İzin verildi: Salt-okunur bir işlem olduğu için izin verildi.');
});

test('afterTask hook: logs an explanation when the step result carries a gate decision', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    plugin.afterTask(null, {
      step: { result: { gate: { decision: 'block', reason: 'unknown_tool_blocked' } } },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Engellendi: Bilinmeyen bir araç/);
});

test('afterTask hook: reads gate from result.meta.gate as an alternate shape', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    plugin.afterTask(null, {
      step: { result: { meta: { gate: { decision: 'review', reason: 'mutating_requires_review' } } } },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Veri değiştiren/);
});

test('afterTask hook: does nothing when the step result has no gate', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    plugin.afterTask(null, { step: { result: { ok: true } } });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 0);
});
