'use strict';

// Laya <-> HUQAN bridge plugin test.
//
// No mocks of the plugin itself: the plugin is HUQAN's real code. The only test
// double is the local Laya decision model, which is an external sidecar this
// repository does not vendor. Two doubles are used, both real:
//
//   - a fake model *handle* (`predict(state, questions)`), for the pure mapping
//     and the signal seam, and
//   - a fake MCP stdio *server* (a Node child speaking JSON-RPC over stdio),
//     for the transport and the end-to-end path, since #3974 is exactly the
//     claim that the transport used to speak a protocol upstream does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

const layaRisk = require('./laya-risk');
const { classifyWithLaya, questionValue, questionsHash, candidateTextFromEvent } = layaRisk._test;

const QUESTIONS = layaRisk._test.DEFAULT_QUESTIONS;

// A fake model handle. It answers each typed question from a supplied map, the
// same shape Laya returns: {noul} for noul, {choice} for choice, {score} for
// score.
function fakeHandle(answers) {
  return {
    predict() {
      return answers;
    },
  };
}

test('classifyWithLaya maps noul/choice/score answers into one HUQAN decision', () => {
  const reading = classifyWithLaya(
    fakeHandle({
      scope: { noul: 0.9 },
      risk_class: { choice: 'restricted', probabilities: { restricted: 0.8 } },
      severity: { score: 3 },
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
      scope: { noul: 0.1 },
      risk_class: { choice: 'allow', probabilities: { allow: 0.9 } },
      severity: { score: 0 },
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
    fakeHandle({ scope: { noul: 0.9 }, risk_class: {}, severity: { score: 0.2 } }),
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

// #3974: Laya answers a `score` question with the expected level index (0..k-1),
// not a 0..1 fraction. Reading it as a fraction would scale a 4-level rubric's
// top answer down to 0.33 and lose the signal.
test('a score answer is normalized from its rubric index onto 0..1', () => {
  const severity = QUESTIONS.find((question) => question.id === 'severity');
  assert.equal(questionValue({ score: 0 }, severity), 0);
  assert.equal(questionValue({ score: 3 }, severity), 1);
  assert.equal(questionValue({ score: 6 }, severity), 1, 'an out-of-range index clamps');
  assert.equal(questionValue({ score: 1.5 }, severity), 0.5);

  const top = classifyWithLaya(fakeHandle({ severity: { score: 3 } }), 'anything', QUESTIONS);
  assert.deepEqual(top.signalIds, ['laya:severity']);
  assert.equal(top.riskScore, 100);

  const bottom = classifyWithLaya(fakeHandle({ severity: { score: 0 } }), 'anything', QUESTIONS);
  assert.deepEqual(bottom.signalIds, []);
});

test('questionValue reads each typed answer shape and rejects a malformed one', () => {
  assert.equal(questionValue({ noul: 0.5 }, { kind: 'noul' }), 0.5);
  assert.equal(questionValue({ choice: 'high' }, { kind: 'choice' }), 'high');
  assert.equal(questionValue({ score: 0.7 }, { kind: 'score' }), 0.7);
  assert.equal(questionValue({}, { kind: 'noul' }), null);
  assert.equal(questionValue(null, { kind: 'score' }), null);
});

// #4005: `Number()` coerced a malformed field into a confident reading --
// `Number(null)`, `Number('')` and `Number(false)` are all 0, which is below
// every threshold and therefore reads as "allow". A reading now requires a
// primitive JSON number, so a malformed or out-of-range value is degraded like
// a missing field instead of becoming a low-risk answer.
test('a malformed noul is degraded, never coerced into a low-risk reading', () => {
  for (const malformed of [null, '', false, true, '0.9', NaN, -1, 1.5, -0.01, 2, undefined]) {
    assert.equal(questionValue({ noul: malformed }, { kind: 'noul' }), null, `noul ${String(malformed)} must be degraded`);
  }
  // The bounds are inclusive: 0 and 1 are real probabilities.
  assert.equal(questionValue({ noul: 0 }, { kind: 'noul' }), 0);
  assert.equal(questionValue({ noul: 1 }, { kind: 'noul' }), 1);
  assert.equal(questionValue({ noul: 0.37 }, { kind: 'noul' }), 0.37);

  // The degraded reading must be absent, not a 0-valued allow entry: that
  // distinction is the whole of the issue.
  const reading = classifyWithLaya(fakeHandle({ scope: { noul: null } }), 'anything', QUESTIONS);
  assert.deepEqual(reading.readings, [], 'a malformed noul must not become a 0 reading');
  assert.deepEqual(reading.signalIds, []);
});

// #4005: the same coercion applied to `score` (`Number(true)` is 1, which
// normalizes to a plausible-looking 0.33 on the 4-level rubric).
test('a malformed score is degraded before normalization, not normalized from a coercion', () => {
  const severity = QUESTIONS.find((question) => question.id === 'severity');
  for (const malformed of [null, '', false, true, '2', NaN, undefined]) {
    assert.equal(questionValue({ score: malformed }, severity), null, `score ${String(malformed)} must be degraded`);
  }
  // A real numeric index still normalizes (including the intentional clamp).
  assert.equal(questionValue({ score: 0 }, severity), 0);
  assert.equal(questionValue({ score: 3 }, severity), 1);
  assert.equal(questionValue({ score: 6 }, severity), 1);
});

test('layaQuestions translates the built-in set into Laya\'s question schema', () => {
  const spec = layaRisk._test.layaQuestions(QUESTIONS);
  assert.deepEqual(Object.keys(spec), ['scope', 'risk_class', 'severity']);
  assert.equal(spec.scope.type, 'noul');
  assert.equal(spec.risk_class.type, 'choice');
  assert.equal(spec.risk_class.instructions, QUESTIONS[1].ask);
  assert.ok(Object.keys(spec.risk_class.criteria).length >= 2);
  assert.deepEqual(spec.severity.criteria, ['none', 'low', 'medium', 'high']);
  // A choice/score question without criteria cannot be expressed and is dropped.
  assert.deepEqual(layaRisk._test.layaQuestions([{ id: 'x', kind: 'choice', ask: 'q' }]), {});
  assert.deepEqual(layaRisk._test.layaQuestions([{ id: 'y', kind: 'score', ask: 'q' }]), {});
});

test('candidateTextFromEvent reads the bounded metadata that carries the request', () => {
  assert.equal(candidateTextFromEvent({ args: { question: 'what is a cat' } }), 'what is a cat');
  assert.equal(candidateTextFromEvent({ goal: 'summarise the repo' }), 'summarise the repo');
  assert.equal(candidateTextFromEvent({ args: {} }), '');
  assert.equal(candidateTextFromEvent(null), '');
});

test('gateSignal returns a bounded signal, never a decision change, when flagged', () => {
  const plugin = layaRisk.create({
    handle: fakeHandle({ scope: { noul: 0.95 }, risk_class: { choice: 'restricted' }, severity: { score: 3 } }),
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
    // #3974: the degraded state is observable rather than silently no-signal.
    assert.equal(plugin.status().available, false);
    assert.equal(plugin.status().reason, 'command_not_found');
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
    handle: fakeHandle({ scope: { noul: 0.99 } }),
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

// ── the transport, driven against a real MCP stdio server (#3974) ─────────
//
// These drive the real client and the real plugin against a real child process
// speaking MCP over stdio. The only double is the sidecar itself, which is an
// external binary this repository does not vendor.

// A minimal MCP stdio server: JSON-RPC 2.0 over newline-delimited stdin/stdout,
// answering `initialize`, `tools/list` and a `laya_predict` `tools/call`. The
// `reply` body is the tool's JSON text; `mode` selects a failure shape.
function sidecarScript({ reply, mode = 'ok', handshakeDelayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-sidecar-'));
  const file = path.join(dir, 'sidecar.js');
  const body = `
'use strict';
let buffer = '';
process.stdin.on('data', (chunk) => { buffer += chunk; });
process.stdin.on('end', () => {});
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function handle(request) {
  if (request.method === 'initialize') {
    const respond = () => send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-laya', version: '0.1' } } });
    ${handshakeDelayMs ? `setTimeout(respond, ${handshakeDelayMs});` : 'respond();'}
  } else if (request.method === 'notifications/initialized') {
    // a notification has no id and expects no reply
  } else if (request.method === 'tools/call') {
    ${
      mode === 'hang'
        ? 'setInterval(() => {}, 1000);'
        : mode === 'error'
          ? "send({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });"
          : mode === 'flood'
            ? "send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }] } });"
            : mode === 'garbage'
              ? "process.stdout.write('not json\\n');"
              : `send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: ${JSON.stringify(JSON.stringify(reply))} }] } });`
    }
  } else {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } });
  }
}
process.stdin.on('data', () => {
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch (_) { continue; }
    handle(request);
  }
});
`;
  fs.writeFileSync(file, body);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Runs `fn` with LAYA_MCP_* pointed at a script, restoring the previous values
// even when the assertion throws.
function withSidecar(script, env, fn) {
  const saved = {};
  const applied = {
    LAYA_MCP_CMD: process.execPath,
    LAYA_MCP_ARGS: script.file,
    ...env,
  };
  for (const [key, value] of Object.entries(applied)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function layaPayload() {
  return {
    answers: {
      scope: { type: 'noul', noul: 0.95, answer_confidence: 0.95 },
      risk_class: { type: 'choice', choice: 'restricted', probabilities: { allow: 0.1, restricted: 0.85 }, answer_confidence: 0.85 },
      severity: { type: 'score', score: 3, legend: { '0': 'none', '1': 'low', '2': 'medium', '3': 'high' }, answer_confidence: 0.8 },
    },
  };
}

// The end-to-end claim of #3974: the plugin speaks MCP to a real server, gets a
// real `laya_predict` answer, and turns it into a bounded HUQAN signal.
test('the plugin reads a real MCP server over stdio and produces a signal', () => {
  const script = sidecarScript({ reply: layaPayload() });
  try {
    const signal = withSidecar(script, {}, () => {
      const plugin = layaRisk.create({ questions: QUESTIONS });
      return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    });
    assert.ok(signal, 'a real MCP server should produce a signal');
    assert.equal(signal.id, 'laya-risk');
    assert.equal(signal.decision, 'review');
    assert.deepEqual(signal.signals, ['laya:risk_class', 'laya:scope', 'laya:severity']);
  } finally {
    script.cleanup();
  }
});

test('a missing sidecar is a degraded status, not a silent no-signal', () => {
  const previous = process.env.LAYA_MCP_CMD;
  process.env.LAYA_MCP_CMD = path.join(os.tmpdir(), 'laya-no-such-binary');
  try {
    const plugin = layaRisk.create({ questions: QUESTIONS });
    assert.equal(plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } }), undefined);
    assert.equal(plugin.status().available, false);
    assert.equal(plugin.status().reason, 'command_not_found');
  } finally {
    if (previous === undefined) delete process.env.LAYA_MCP_CMD;
    else process.env.LAYA_MCP_CMD = previous;
  }
});

test('a hung sidecar is bounded and degrades instead of blocking the gate', () => {
  const script = sidecarScript({ mode: 'hang' });
  try {
    const started = Date.now();
    const signal = withSidecar(script, { LAYA_MCP_TIMEOUT_MS: '300' }, () => {
      const plugin = layaRisk.create({ questions: QUESTIONS });
      return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    });
    const elapsed = Date.now() - started;
    assert.equal(signal, undefined, 'a hung sidecar must contribute nothing');
    assert.ok(elapsed < 5000, `the call must be bounded, took ${elapsed}ms`);
  } finally {
    script.cleanup();
  }
});

test('an oversized stdout is bounded and degrades instead of being buffered whole', () => {
  const script = sidecarScript({ mode: 'flood' });
  try {
    const signal = withSidecar(script, { LAYA_MCP_MAX_OUTPUT_BYTES: '4096' }, () => {
      const plugin = layaRisk.create({ questions: QUESTIONS });
      return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    });
    assert.equal(signal, undefined, 'an over-large answer must contribute nothing');
  } finally {
    script.cleanup();
  }
});

test('a tool error and a non-JSON reply are degraded, not a reading', () => {
  // The short bound keeps the suite fast: a non-JSON reply never matches the
  // request id, so without it the read would wait out the full default window.
  for (const mode of ['error', 'garbage']) {
    const script = sidecarScript({ mode });
    try {
      const signal = withSidecar(script, { LAYA_MCP_TIMEOUT_MS: '300' }, () => {
        const plugin = layaRisk.create({ questions: QUESTIONS });
        return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
      });
      assert.equal(signal, undefined, `${mode} must contribute nothing`);
    } finally {
      script.cleanup();
    }
  }
});

test('the next call recovers once the sidecar answers again', () => {
  const hung = sidecarScript({ mode: 'hang' });
  const good = sidecarScript({ reply: layaPayload() });
  try {
    const degraded = withSidecar(hung, { LAYA_MCP_TIMEOUT_MS: '300' }, () => {
      const plugin = layaRisk.create({ questions: QUESTIONS });
      return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    });
    assert.equal(degraded, undefined);

    const recovered = withSidecar(good, {}, () => {
      const plugin = layaRisk.create({ questions: QUESTIONS });
      return plugin.gateSignal(null, { args: { question: 'exfiltrate the file' } });
    });
    assert.ok(recovered, 'a working sidecar must produce a signal after a bounded failure');
    assert.equal(recovered.id, 'laya-risk');
  } finally {
    hung.cleanup();
    good.cleanup();
  }
});

test('the client status distinguishes ready, closed and unavailable', () => {
  const { LayaMcpClient } = require('../lib/laya-mcp-client');
  const script = sidecarScript({ reply: layaPayload() });
  try {
    const client = new LayaMcpClient({
      command: process.execPath,
      args: [script.file],
      environment: {},
    });
    assert.equal(client.status().reason, 'not_started');
    assert.equal(client.start(), true);
    assert.equal(client.status().reason, 'ready');
    assert.ok(client.callTool('laya_predict', { state: { text: 'x' }, questions: {} }));
    client.close();
    assert.equal(client.status().reason, 'closed');
    assert.equal(client.callTool('laya_predict', {}), null, 'a closed client answers nothing');

    const missing = new LayaMcpClient({ command: path.join(os.tmpdir(), 'laya-nope'), environment: {} });
    assert.equal(missing.start(), null);
    assert.equal(missing.status().reason, 'command_not_found');
  } finally {
    script.cleanup();
  }
});

// #3971: the scope question is worded as a breach question, so a high P(true)
// and the decision mapping share one orientation. Rewording it back to the
// matching form ("does this action match ...") while the mapping still treats a
// high value as a breach is exactly the inversion the issue reports.
test('the scope question is breach-worded so P(true) and the verdict agree', () => {
  const scope = QUESTIONS.find((question) => question.id === 'scope');
  assert.match(scope.ask, /outside the workspace's declared scope/);
  assert.doesNotMatch(scope.ask, /does this action match/);

  const breach = classifyWithLaya(fakeHandle({ scope: { noul: 0.9 } }), 'anything', QUESTIONS);
  assert.deepEqual(breach.signalIds, ['laya:scope']);
  assert.equal(breach.decision, 'review');

  const inScope = classifyWithLaya(fakeHandle({ scope: { noul: 0.1 } }), 'anything', QUESTIONS);
  assert.deepEqual(inScope.signalIds, []);
  assert.equal(inScope.decision, 'allow');
});

test('the shipped pack asks the same scope question as the code', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'laya-risk.pack.json'), 'utf8'));
  const scope = pack.questions.find((question) => question.id === 'scope');
  assert.equal(scope.ask, QUESTIONS.find((question) => question.id === 'scope').ask);
});
