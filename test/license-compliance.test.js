'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { checkLicenses, packageNameFromPath } = require('../scripts/check-licenses');

test('license checker accepts permissive dependency licenses', () => {
  const lockfile = {
    packages: {
      '': { license: 'AGPL-3.0-only' },
      'node_modules/a': { license: 'MIT' },
      'node_modules/@scope/b': { license: 'Apache-2.0' },
    },
  };
  assert.deepEqual(checkLicenses(lockfile), []);
});

test('license checker rejects copyleft, proprietary, non-commercial and missing licenses', () => {
  const lockfile = {
    packages: {
      '': { license: 'AGPL-3.0-only' },
      'node_modules/gpl': { license: 'GPL-3.0-only' },
      'node_modules/private': { license: 'PROPRIETARY' },
      'node_modules/noncommercial': { license: 'CC-BY-NC-4.0' },
      'node_modules/missing': {},
    },
  };
  const violations = checkLicenses(lockfile);
  assert.equal(violations.length, 4);
  assert.deepEqual(violations.map((item) => item.package), ['gpl', 'private', 'noncommercial', 'missing']);
});

test('license exceptions require an exact license and documented reason', () => {
  const lockfile = { packages: { '': {}, 'node_modules/legacy': { license: 'GPL-3.0-only' } } };
  assert.equal(checkLicenses(lockfile, { legacy: { license: 'GPL-3.0-only', reason: 'Reviewed exception' } }).length, 0);
  assert.equal(checkLicenses(lockfile, { legacy: { license: 'GPL-3.0-only' } }).length, 1);
  assert.equal(checkLicenses(lockfile, { legacy: { license: 'MIT', reason: 'Wrong license' } }).length, 1);
});

test('missing license metadata requires an explicit documented sentinel exception', () => {
  const lockfile = { packages: { '': {}, 'node_modules/legacy': {} } };
  assert.equal(checkLicenses(lockfile, { legacy: { license: '<missing>', reason: 'License verified upstream' } }).length, 0);
  assert.equal(checkLicenses(lockfile, { legacy: { license: 'MIT', reason: 'Not exact lockfile metadata' } }).length, 1);
});

test('scoped package names are preserved', () => {
  assert.equal(packageNameFromPath('node_modules/@scope/pkg'), '@scope/pkg');
});

test('current repository lockfile passes license compliance', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-licenses.js')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
