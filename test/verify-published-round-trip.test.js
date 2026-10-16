'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNpmViewJson } = require('../scripts/verify-published-round-trip');

// Shapes captured from `npm view huqan@0.13.1 <field> --json` (#3323).
const DIST = {
  shasum: 'df3bc2cc9a5e4afeca1ee7ebadb29f8a97918d8d',
  tarball: 'https://registry.npmjs.org/huqan/-/huqan-0.13.1.tgz',
  integrity: 'sha512-AAAA',
};

test('npm 11 bare dist object is returned as is', () => {
  assert.deepEqual(parseNpmViewJson(JSON.stringify(DIST, null, 2)), DIST);
});

test('npm 12 one-element array is unwrapped to the same dist object', () => {
  assert.deepEqual(parseNpmViewJson(JSON.stringify([DIST], null, 2)), DIST);
});

test('a scalar field reads the same under npm 11 and npm 12', () => {
  assert.equal(parseNpmViewJson('"0.13.1"\n'), '0.13.1');
  assert.equal(parseNpmViewJson('[\n  "0.13.1"\n]\n'), '0.13.1');
});

test('a leading BOM does not break parsing', () => {
  assert.equal(parseNpmViewJson('﻿"0.13.1"'), '0.13.1');
});
