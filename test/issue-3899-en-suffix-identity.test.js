'use strict';

// #3899: `normalize` stripped `ing|ed|es|s` off every English word, so a taught
// technical term was sealed into the graph under a corrupted identity
// (`kubernetes` -> `kubernet`, `redis` -> `redi`, `status` -> `statu`). The
// user's own spelling then never matched, and the concept was unreachable for
// ask/verify/search. The length guard only protected words up to three letters,
// and no rule separated a real `-s` plural from a root that ends in `s`
// (`class`, `status`, `redis`, `analysis`).
//
// These tests teach a term through the real kernel and read it back with the
// user's spelling, so a regression fails at the surface the issue describes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const en = require('../nlp/lang-en');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');

const TERMS = ['kubernetes', 'redis', 'status', 'series', 'process', 'https', 'class'];

function makeKernel(label) {
  return new Kernel(isolatedKernelOptions(`3899-${label}`, { noLoad: true, loadPlugins: false, useSQLite: false }));
}

// learn only commits through the admission gate: a canonical mutation needs an
// approved approval and provenance, exactly as batch-caller-measurement does.
function admittedOpts(n) {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr_${n}`,
    admissionRequired: true,
    provenance: {
      provenanceId: `prov-${n}`,
      sourceType: 'manual',
      sourceRef: `t:${n}`,
      actor: 'test',
      workspaceId: 'default',
      timestamp: '2026-06-29T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  };
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

test('#3899 a technical term keeps its spelling through normalize', () => {
  for (const term of TERMS) {
    assert.equal(en.normalize(term), term, `${term} must survive normalization unchanged`);
  }
});

test('#3899 a real plural still folds to its singular', () => {
  for (const [surface, stem] of [
    ['cats', 'cat'],
    ['dogs', 'dog'],
    ['notes', 'note'],
    ['keys', 'key'],
    ['windows', 'window'],
    ['boxes', 'box'],
    ['classes', 'class'],
  ]) {
    assert.equal(en.normalize(surface), stem, `${surface} -> ${stem}`);
  }
});

test('#3899 a taught term is found by verify with the user spelling', () => {
  const kernel = makeKernel('verify');
  try {
    let n = 0;
    for (const term of TERMS) {
      n += 1;
      const learned = kernel.learn(`the ${term} runs the api server`, admittedOpts(n));
      assert.equal(learned.ok, true, `${term} must learn`);
      assert.equal(learned.data.learned, 1, `${term} must land an edge`);

      // The node identity is the user's spelling, not a stem.
      assert.ok(kernel.graph.getNode(term, 'default'), `${term} must be a node verbatim`);

      const verified = kernel.verify(`${term} runs the api server`, { workspaceId: 'default' });
      assert.notEqual(verified.type, 'error', `${term} must verify with the user spelling`);
    }
  } finally {
    closeKernel(kernel);
  }
});

test('#3899 a taught term is found by ask with the user spelling', () => {
  const kernel = makeKernel('ask');
  try {
    kernel.learn('the kubernetes control plane runs the api server', admittedOpts(1));
    assert.ok(kernel.graph.getNode('kubernetes', 'default'), 'the node must be `kubernetes`');

    const answer = kernel.ask('what does the kubernetes control plane run');
    assert.notEqual(answer.type, 'error');
    assert.equal(answer.data.unknown, false, 'the question must resolve, not fall to the identity subject');
    assert.equal(answer.data.subject, 'kubernetes');
  } finally {
    closeKernel(kernel);
  }
});
