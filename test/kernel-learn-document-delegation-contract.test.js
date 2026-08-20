'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runLearnDocument } = require('../lib/kernel-learn-document');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-learn-document.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Kernel`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('KERNEL: learnDocument is a one-line delegate', () => {
  assert.equal(
    methodBody(kernelSource, 'learnDocument'),
    'return runLearnDocument((line, options) => this.learn(line, options), text, opts);',
  );
});

test('KERNEL: learnDocument delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /kernel\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/kernel["']\)/);
  assert.doesNotMatch(delegateSource, /this\._|this\.learn/);
  assert.match(delegateSource, /learn\(cleaned, opts\)/);
  assert.match(delegateSource, /returnDetails/);
});

test('KERNEL: learnDocument preserves cleaned order and detail/numeric returns', () => {
  const calls = [];
  const options = { returnDetails: true, admissionRequired: true };
  const learn = (text, opts) => {
    calls.push({ text, opts });
    return text === 'kedi hayvandir'
      ? { data: { learned: 1, admission: { outcome: 'review' } } }
      : { data: { learned: 0 } };
  };

  const detailed = runLearnDocument(
    learn,
    '# heading\n- kedi hayvandir\n// comment\nkopek memelidir\ntek',
    options,
  );
  assert.deepEqual(calls.map(call => call.text), ['kedi hayvandir', 'kopek memelidir']);
  assert.ok(calls.every(call => call.opts === options));
  assert.deepEqual(detailed, { learned: 1, admissions: [{ outcome: 'review' }] });

  const numeric = runLearnDocument(
    () => ({ data: { learned: 1 } }),
    'bir cümle\niki kelime',
  );
  assert.equal(numeric, 2);
});
