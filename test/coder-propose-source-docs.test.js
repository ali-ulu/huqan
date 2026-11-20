'use strict';

/**
 * #4623 — `coder propose --source` and its trusted-oracle contract must stay
 * discoverable. The option was added after #4535 closed the earlier Coder
 * command reference, and a public flag that only exists in source is a flag
 * nobody finds.
 *
 * This pins the two public surfaces to the same facts: the flag is listed, the
 * attestation variable is named, and neither surface may describe a bare
 * environment variable as proof of independence (#4624). Pinning the *negative*
 * claim matters as much as the positive one -- a future edit that reinstates
 * "set HUQAN_ACCEPTANCE_CHANNEL=ci" would make the documentation lie about the
 * security property the code now enforces.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cliHelpText } = require('../lib/cli-help');
const { ACCEPTANCE_ENV } = require('../lib/experience/learning-source');

const ROOT = path.resolve(__dirname, '..');
const QUICKSTART = fs.readFileSync(path.join(ROOT, 'docs', 'coder-quickstart.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('CLI help lists --source for coder propose', () => {
  const help = cliHelpText();
  assert.match(help, /coder propose <failure\.json> \[--source <source\.json>\]/u);
  // The help must also say why the flag exists, not just that it does.
  assert.match(help, /acceptance[\s\S]{0,80}oracle/u);
  assert.match(help, /not proof of independence/u);
});

test('the quickstart documents --source in the command reference', () => {
  assert.match(QUICKSTART, /coder propose <failure\.json> \[--source <source\.json>\]/u);
  assert.match(QUICKSTART, /## `coder propose --source`/u);
});

test('the quickstart names the attestation variable it actually reads', () => {
  assert.match(QUICKSTART, new RegExp(ACCEPTANCE_ENV.ATTESTATION, 'u'));
  // Every documented refusal is a code the module can actually return, so the
  // table cannot drift into describing behaviour nobody implemented.
  const { CODES } = require('../lib/experience/learning-source');
  for (const code of ['ORACLE_SUPPLY_UNVERIFIED', 'ORACLE_NOT_INDEPENDENT', 'OUTCOME_CONFLICTING']) {
    assert.ok(QUICKSTART.includes(CODES[code]), `quickstart must document ${CODES[code]}`);
  }
});

test('the quickstart states that a channel variable is not evidence', () => {
  // #4624: this sentence is the whole security claim. Losing it would let the
  // documentation imply the old, forgeable design.
  assert.match(QUICKSTART, /HUQAN_ACCEPTANCE_CHANNEL=ci[^\n]*grants nothing/u);
  assert.match(QUICKSTART, /not\*\* trusted inputs/u);
  // And it must not present the old variables as usable inputs.
  assert.doesNotMatch(QUICKSTART, /HUQAN_ACCEPTANCE_CHANNEL[^\n]{0,40}(trusted launcher|CI input)/iu);
});

test('independence is described as a property of the signer', () => {
  assert.match(QUICKSTART, /property of \*who signed the oracle\*/u);
  assert.match(QUICKSTART, /decision envelope/u);
  // The trust anchor is the installed OS-boundary pin, and only that.
  assert.match(QUICKSTART, /os-service/u);
  assert.match(QUICKSTART, /env-override/u);
});

test('README still routes the Coder command reference to the quickstart', () => {
  // The option is only discoverable if the README keeps pointing at the page
  // that documents it.
  assert.match(README, /docs\/coder-quickstart\.md/u);
  assert.match(README, /`propose`/u);
});
