'use strict';

// #3913: bare `DB_PATH`/`MEMORY_PATH` are not read by the runtime -- only the
// `HUQAN_`/`AXIOM_` names are -- and the ignore used to be silent, so a caller
// that set the bare name quietly opened the default shared `memory.db`. The
// boot now warns. These cases lock the detection and the noise boundary (a
// generic name like `PORT`, or a bare name set alongside its canonical one,
// must stay quiet).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatIgnoredBareEnvironmentWarning,
  ignoredBareEnvironmentNames,
  reportIgnoredBareEnvironment,
} = require('../lib/environment-compat');

test('a bare DB_PATH with no HUQAN_/AXIOM_ spelling is reported as ignored (#3913)', () => {
  const ignored = ignoredBareEnvironmentNames({ DB_PATH: '/tmp/isolated.db' });
  assert.deepEqual(ignored, [{ bare: 'DB_PATH', canonical: 'HUQAN_DB_PATH', legacy: 'AXIOM_DB_PATH' }]);

  const warning = formatIgnoredBareEnvironmentWarning(ignored[0]);
  assert.match(warning, /HUQAN ignores DB_PATH/);
  assert.match(warning, /HUQAN_DB_PATH/);
  // The message names variables, never the value.
  assert.equal(warning.includes('/tmp/isolated.db'), false);
});

test('a bare name alongside its canonical spelling is a leftover, not a mistake (#3913)', () => {
  assert.deepEqual(
    ignoredBareEnvironmentNames({ DB_PATH: '/tmp/old.db', HUQAN_DB_PATH: '/tmp/new.db' }),
    [],
  );
  assert.deepEqual(
    ignoredBareEnvironmentNames({ MEMORY_PATH: '/tmp/m.json', AXIOM_MEMORY_PATH: '/tmp/m.json' }),
    [],
  );
});

test('generic host names that happen to be suffixes do not warn (#3913)', () => {
  assert.deepEqual(ignoredBareEnvironmentNames({ PORT: '3000', LANG: 'tr_TR.UTF-8', HOST: '0.0.0.0' }), []);
});

test('empty and absent bare names are not reported (#3913)', () => {
  assert.deepEqual(ignoredBareEnvironmentNames({ DB_PATH: '' }), []);
  assert.deepEqual(ignoredBareEnvironmentNames({}), []);
});

test('reportIgnoredBareEnvironment warns once per ignored name (#3913)', () => {
  const warnings = [];
  reportIgnoredBareEnvironment({ warn: message => warnings.push(message) }, {
    DB_PATH: '/tmp/isolated.db',
    MEMORY_PATH: '/tmp/m.json',
  });

  assert.equal(warnings.length, 2);
  assert.ok(warnings.some(message => message.includes('DB_PATH')));
  assert.ok(warnings.some(message => message.includes('MEMORY_PATH')));
  assert.equal(warnings.some(message => message.includes('/tmp/')), false);
});
