'use strict';

/**
 * What a first-time reader sees, from a clean install, following README.md.
 *
 * Three separate defects made a working product look broken in its first sixty
 * seconds, and all three were in output rather than behaviour:
 *
 *   #1693 — the gate refusal for `learn:` was Turkish, half its diacritics
 *           stripped, and named no way forward.
 *   #1694 — every command opened with five `[Plugin] … disabled` warnings on
 *           stderr before its first real line.
 *   #1695 — the quickstart's own "run this next" suggestion answered
 *           `unknown (confidence: 0.00)` for the claim it had just verified.
 *
 * These tests pin the output, because output is the whole defect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENGLISH_COMMAND_NAMES,
  commandLabel,
  formatCliGateMessage,
} = require('../lib/cli-gate-message');
const { formatPluginCapabilityStatus } = require('../lib/cli-plugin-status');

/** Latin letters, ASCII punctuation and whitespace only. */
const NON_ENGLISH = /[^\x20-\x7e\n]/;

test('every gate message is English, with no stripped-diacritic Turkish', () => {
  for (const decision of ['review', 'dry_run_only', 'block']) {
    const message = formatCliGateMessage('öğret', { decision, reason: 'some_reason' });
    assert.doesNotMatch(message, NON_ENGLISH, `${decision} message contains non-ASCII text`);
    for (const word of ['gerektiriyor', 'yapilmadi', 'baslatilmadi', 'engellendi', 'Karar', 'Sebep', 'Calisma']) {
      assert.doesNotMatch(message, new RegExp(word, 'i'), `${decision} message still contains "${word}"`);
    }
  }
});

test('a refused command names the decision, the reason, and what to do next', () => {
  const message = formatCliGateMessage('öğret', {
    decision: 'review',
    reason: 'mutating_requires_review',
  });
  assert.match(message, /requires review/);
  assert.match(message, /decision: review/);
  assert.match(message, /reason: mutating_requires_review/);
  assert.match(message, /Nothing was mutated/);
  // The next step has to be real: the CLI gate refuses before the command runs,
  // so no approval record exists and `huqan approvals` would be empty.
  assert.match(message, /huqan quickstart/);
  assert.doesNotMatch(message, /run `huqan approvals` to approve/);
});

test('the message names the command the reader typed, not its internal spelling', () => {
  assert.match(formatCliGateMessage('öğret', { decision: 'review' }), /"learn"/);
  assert.match(formatCliGateMessage('düşün', { decision: 'block' }), /"think"/);
  assert.equal(commandLabel('öğret'), 'learn');
  assert.equal(commandLabel('unknown-command'), 'unknown-command');
  assert.equal(commandLabel(''), 'command');
  assert.equal(commandLabel(undefined), 'command');

  // Every mapped name is itself plain English.
  for (const english of Object.values(ENGLISH_COMMAND_NAMES)) {
    assert.doesNotMatch(english, NON_ENGLISH, `${english} is not plain ASCII`);
  }
});

test('an unknown decision still fails closed with a blocked message', () => {
  const message = formatCliGateMessage('öğret', { decision: 'something_new', reason: 'r' });
  assert.match(message, /was blocked. Nothing ran/);
});

/** A plugin manager double with the shape cli-plugin-status reads. */
function pluginManager({ loaded = [], notices = [] } = {}) {
  return {
    plugins: loaded.map(name => ({ name })),
    capabilityNotices: notices,
    capabilitySummary() {
      return {
        loaded: this.plugins.map(plugin => plugin.name).sort(),
        skipped: notices.filter(n => n.kind === 'required').map(n => ({ plugin: n.plugin, capability: n.capability })),
        degraded: notices.filter(n => n.kind === 'optional').map(n => ({ plugin: n.plugin, capability: n.capability })),
      };
    },
  };
}

test('capability notices are reported by status, not printed on every command', () => {
  const manager = pluginManager({
    loaded: ['devil-advocate', 'secret-masker'],
    notices: [
      { plugin: 'company-brain', capability: 'companyMode', kind: 'required' },
      { plugin: 'devil-advocate', capability: 'evidenceRanking', kind: 'optional' },
    ],
  });

  const status = formatPluginCapabilityStatus(manager);
  assert.match(status, /Plugins active \(2\): devil-advocate, secret-masker/);
  // An inactive plugin is a switch to flip, not a failure.
  assert.match(status, /company-brain: inactive — enable capability 'companyMode'/);
  assert.match(status, /devil-advocate: active, optional capability 'evidenceRanking' is off/);
  assert.doesNotMatch(status, /skipped|disabled|failed/i);
});

test('a status report with nothing to say is empty, not a blank section', () => {
  assert.equal(formatPluginCapabilityStatus(null), '');
  assert.equal(formatPluginCapabilityStatus({}), '');
  assert.equal(formatPluginCapabilityStatus(pluginManager()), '');
});

test('the plugin loader records capability notices instead of writing them out', () => {
  const PluginManager = require('../plugin');
  const kernel = { hasCapability: () => false };
  const manager = new PluginManager(kernel);

  assert.deepEqual(manager.capabilityNotices, [], 'a fresh manager has nothing to report');

  manager.recordCapabilityNotice({ plugin: 'company-brain', capability: 'companyMode', kind: 'required' });
  manager.recordCapabilityNotice({ plugin: 'company-brain', capability: 'companyMode', kind: 'required' });
  assert.equal(manager.capabilityNotices.length, 1, 'notices are deduplicated across repeated loads');

  manager.recordCapabilityNotice({ plugin: 'idea-mri', capability: 'evidenceRanking', kind: 'optional' });
  const summary = manager.capabilitySummary();
  assert.deepEqual(summary.skipped, [{ plugin: 'company-brain', capability: 'companyMode' }]);
  assert.deepEqual(summary.degraded, [{ plugin: 'idea-mri', capability: 'evidenceRanking' }]);
});

test('the loader no longer writes plugin capability lines to the console', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'plugin.js'), 'utf8');
  assert.doesNotMatch(source, /console\.warn\(`\[Plugin\]/, 'capability notices must not be printed');
  assert.match(source, /recordCapabilityNotice/);
});

test('quickstart points at commands that work on an empty graph', () => {
  const { formatQuickstartResult } = require('../lib/quickstart');
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'quickstart.js'), 'utf8');

  assert.equal(typeof formatQuickstartResult, 'function');
  // The claim the quickstart verified lived in the throwaway store it deleted,
  // so suggesting a verify of it answers `unknown` against the reader's graph.
  assert.doesNotMatch(source, /Next: run `huqan` for the interactive shell, or `huqan "verify: smoking causes cancer"`/);
  assert.match(source, /Your own graph is still empty/);
  assert.match(source, /huqan status/);
});
