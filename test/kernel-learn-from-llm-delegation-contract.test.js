'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runLearnFromLLM } = require('../lib/kernel-learn-from-llm');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-learn-from-llm.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Kernel`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('KERNEL: learnFromLLM is a one-line delegate', () => {
  assert.equal(
    methodBody(kernelSource, 'learnFromLLM'),
    'return runLearnFromLLM(text, opts, { paranoidMode: this.paranoidMode, contractVersion: this.contractVersion, verify: (statement, verifyOpts) => this.verify(statement, verifyOpts), learn: (sentence, learnOpts) => this.learn(sentence, learnOpts) });',
  );
});

test('KERNEL: learnFromLLM delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /kernel\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/kernel["']\)/);
  assert.doesNotMatch(delegateSource, /this\._|this\.learn|this\.verify/);
  assert.match(delegateSource, /admissionRequired: true/);
  assert.match(delegateSource, /defaultApprovalRequired\(\)/);
});

test('KERNEL: learnFromLLM preserves paranoid fail-closed synchronous result', () => {
  const result = runLearnFromLLM('kedi hayvandir.', {}, {
    paranoidMode: true,
    contractVersion: 'v5-test',
    verify: () => { throw new Error('verify must not run in paranoid mode'); },
    learn: () => { throw new Error('learn must not run in paranoid mode'); },
  });

  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, {
    learned: 0,
    skipped: 0,
    conflicts: [],
    ok: false,
    error: {
      code: 'LLM_DISABLED',
      message: 'Paranoid mode is active: outbound LLM calls and automatic learning are blocked.',
    },
    meta: { contractVersion: 'v5-test', paranoidMode: true },
  });
});

test('KERNEL: learnFromLLM preserves conflict filtering and sentence cleaning', () => {
  const verifyCalls = [];
  const learnCalls = [];
  const result = runLearnFromLLM(
    '# çelişkili bilgi. - kabul edilen bilgi. tek',
    { workspaceId: 'workspace-1' },
    {
      paranoidMode: false,
      contractVersion: 'v5-test',
      verify: (statement, opts) => {
        verifyCalls.push({ statement, opts });
        return { data: { status: statement === 'çelişkili bilgi' ? 'contradicted' : 'verified' } };
      },
      learn: (sentence, opts) => {
        learnCalls.push({ sentence, opts });
        return { data: { learned: 1 } };
      },
    },
  );

  assert.deepEqual(result, { learned: 1, skipped: 1, conflicts: ['çelişkili bilgi'] });
  assert.deepEqual(verifyCalls.map(call => call.statement), ['çelişkili bilgi', 'kabul edilen bilgi']);
  assert.deepEqual(verifyCalls.map(call => call.opts), [{ workspaceId: 'workspace-1' }, { workspaceId: 'workspace-1' }]);
  assert.equal(learnCalls.length, 1);
  assert.equal(learnCalls[0].sentence, 'kabul edilen bilgi');
  assert.equal(learnCalls[0].opts.workspaceId, 'workspace-1');
  assert.equal(learnCalls[0].opts.admissionRequired, true);
});

test('KERNEL: learnFromLLM preserves approved synchronous learn callback options', () => {
  const learnCalls = [];
  const provenance = { provenanceId: 'p-1', workspaceId: 'workspace-2' };
  const result = runLearnFromLLM(
    'kedi hayvandir.',
    { skipConflicts: false, provenance, approvalRequired: true },
    {
      paranoidMode: false,
      contractVersion: 'v5-test',
      verify: () => { throw new Error('verify must not run when skipConflicts is false'); },
      learn: (sentence, opts) => {
        learnCalls.push({ sentence, opts });
        return { data: { learned: 1 } };
      },
    },
  );

  assert.equal(result instanceof Promise, false);
  assert.deepEqual(result, { learned: 1, skipped: 0, conflicts: [] });
  assert.equal(learnCalls[0].sentence, 'kedi hayvandir');
  assert.deepEqual(learnCalls[0].opts.provenance, provenance);
  assert.notEqual(learnCalls[0].opts.provenance, provenance);
  assert.equal(learnCalls[0].opts.admissionRequired, true);
  assert.equal(learnCalls[0].opts.approvalRequired, true);
  assert.equal(learnCalls[0].opts.workspaceId, 'workspace-2');
});
