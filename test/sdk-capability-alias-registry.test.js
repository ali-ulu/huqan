'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2208 (#2123): lib/sdk.js resolved SDK command aliases to plugin capability
// names through a switch that grew with every plugin or alias. The mapping is
// now a table, in the shape #2464 gave the CLI aliases. The first block pins
// today's behaviour and must be green before and after the change.

const { resolveCapabilityName, normalizeCommandName } = require('../lib/sdk');

describe('resolveCapabilityName behaviour (unchanged)', () => {
  it('maps every alias to its capability', () => {
    const expected = {
      mri: 'ideaMri',
      ideamri: 'ideaMri',
      devil: 'devilAdvocate',
      deviladvocate: 'devilAdvocate',
      contradictions: 'contradictionAlert',
      contradiction: 'contradictionAlert',
      contradictionalert: 'contradictionAlert',
      shield: 'shield',
      verify: 'verify',
      reason: 'reason',
    };
    for (const [alias, capability] of Object.entries(expected)) {
      assert.equal(resolveCapabilityName(alias), capability, alias);
    }
  });

  it('normalizes the command before looking it up', () => {
    assert.equal(normalizeCommandName(' Devil-Advocate '), 'deviladvocate');
    assert.equal(resolveCapabilityName('Idea MRI'), 'ideaMri');
    assert.equal(resolveCapabilityName(' Devil-Advocate '), 'devilAdvocate');
    assert.equal(resolveCapabilityName('CONTRADICTION_ALERT'), 'contradictionAlert');
    assert.equal(resolveCapabilityName('Shield!'), 'shield');
    assert.equal(resolveCapabilityName('VERIFY'), 'verify');
    assert.equal(resolveCapabilityName('ideaMri'), 'ideaMri');
  });

  it('anything that is not a known alias resolves to null', () => {
    for (const command of [undefined, null, '', '   ', 'unknown', '123', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(resolveCapabilityName(command), null, String(command));
    }
  });
});

describe('the alias mapping is a registry (#2208)', () => {
  it('lib/sdk.js no longer dispatches aliases through a switch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*normalized\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch in lib/sdk.js', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'lib/sdk.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
