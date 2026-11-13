'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deriveStringArrayEvidence, prepareStringArrayEvidence, matchesSemanticOperation } = require('../lib/experience/string-array-evidence');
const { renderStringArrayProgram, evaluateStringArrayProgram } = require('../lib/experience/string-array-program');

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const expression = type => renderStringArrayProgram({ type, separator: ',' }, 'value').slice(7, -1);
const content = "module.exports = function(value) { return value.join(','); };\n";
const operation = { type: 'replace_text', path: 'target.js', find: "value.join(',')", replace: expression('stableUniqueJoin') };
const task = { synthesisEvidenceTarget: { binding: 'value', separator: ',' }, synthesisSourcePin: { path: 'target.js', sha256: hash(content) } };
const args = { task, operation, content, runId: 'run', workspaceId: 'workspace', eventId: 'event' };

test('evidence binds closed programs and full output bytes to the operation and context', () => {
  const evidence = deriveStringArrayEvidence(args);
  assert.ok(evidence);
  assert.deepEqual(evidence.before, { type: 'join', separator: ',' });
  assert.deepEqual(evidence.after, { type: 'stableUniqueJoin', separator: ',' });
  assert.deepEqual(evidence.context, { runId: 'run', workspaceId: 'workspace', eventId: 'event' });
  assert.equal(evidence.sourcePin.sha256, hash(content));
  assert.equal(evidence.afterSourceSha256, hash(content.replace(operation.find, operation.replace)));
  assert.equal(evidence.findSha256, hash(operation.find));
  assert.equal(evidence.replaceSha256, hash(operation.replace));
  assert.equal(matchesSemanticOperation(evidence, operation), true);
  assert.equal(matchesSemanticOperation(evidence, { ...operation, path: 'wrong.js' }), false);
  assert.equal(deriveStringArrayEvidence({ ...args, content: content + '// drift' , task: { synthesisEvidenceTarget: { binding: 'wrong', separator: ',' } } }), null);
  for (const [input, expected] of [[[], ''], [['GET','GET','POST'], 'GET,POST'], [['POST','GET','POST'], 'POST,GET'], [['', ',',''], ',,']])
    assert.equal(evaluateStringArrayProgram(evidence.after, input), expected);
});

test('untrusted getters and proxies are rejected without invocation or coercion', () => {
  let calls = 0;
  const getter = key => Object.defineProperty({}, key, { enumerable: true, get() { calls++; throw Error('getter'); } });
  const bad = [new Proxy(task, {}), getter('synthesisEvidenceTarget'), { synthesisEvidenceTarget: getter('binding') }];
  for (const value of bad) assert.equal(deriveStringArrayEvidence({ ...args, task: value }), null);
  const intent = { type: 'replace_text', path: 'target.js' };
  const baseCandidate = { capabilityId: 'id', sourceRunIds: [], params: { path: 'target.js', oldText: operation.find, newText: operation.replace }, qualificationPaths: [] };
  for (const experience of [getter('intentOnly'), new Proxy({}, {}),
    { intentOnly: true, riskTier: 'l0', candidates: new Proxy([], {}) },
    { intentOnly: true, riskTier: 'l0', candidates: [getter('params')] },
    { intentOnly: true, riskTier: 'l0', candidates: [{ ...baseCandidate, params: getter('path') }] }])
    assert.equal(deriveStringArrayEvidence({ ...args, task: { ...task, experience }, operation: intent }), null);
  const taskWithGetter = { ...task }; Object.defineProperty(taskWithGetter, 'experience', Object.getOwnPropertyDescriptor(getter('experience'), 'experience'));
  assert.equal(deriveStringArrayEvidence({ ...args, task: taskWithGetter, operation: intent }), null);
  const toxic = { toString() { calls++; throw Error('coercion'); } };
  assert.equal(matchesSemanticOperation({ sourcePin: { path: 'target.js', sha256: toxic }, findSha256: toxic, replaceSha256: toxic }, { ...operation, find: toxic }), false);
  assert.deepEqual(prepareStringArrayEvidence({ ...args, task: getter('synthesisEvidenceTarget'), readSource: () => content }), { required: true, evidence: null });
  assert.equal(calls, 0);
});

test('source pin and metadata are checked before reading and stale bytes fail closed', () => {
  let reads = 0, calls = 0;
  const readSource = () => { reads++; return content; };
  const getter = key => Object.defineProperty({}, key, { enumerable: true, get() { calls++; throw Error('getter'); } });
  const toxic = { toString() { calls++; throw Error('coercion'); } };
  for (const invalid of [undefined, {}, { path: 'target.js', sha256: '0'.repeat(64), extra: true },
    { path: 'other.js', sha256: hash(content) }, { path: 'target.js', sha256: toxic },
    getter('sha256'), new Proxy({ path: 'target.js', sha256: hash(content) }, {})]) {
    const result = prepareStringArrayEvidence({ ...args, task: { ...task, synthesisSourcePin: invalid }, readSource });
    assert.equal(result.evidence, null);
  }
  for (const invalid of [new Proxy(operation, {}), getter('path')])
    assert.equal(prepareStringArrayEvidence({ ...args, operation: invalid, readSource }).evidence, null);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.equal(deriveStringArrayEvidence({ ...args, content: content + '// drift' }), null);
});
