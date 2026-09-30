'use strict';

/**
 * `.opencodereview/rule.json` is a contract, not a preference file (#3197).
 *
 * It exists to stop the repository's known traps from being re-learned by every
 * agent, and it is read by a tool that is *not* in this repository -- so nothing
 * else here would notice if the file stopped parsing, dropped its test include,
 * or started resolving a path to the wrong rule. These tests pin the three
 * things the issue's acceptance criteria actually depend on:
 *
 *   - the include keeps `test/**` reviewable, because in HUQAN many tests are
 *     contracts and a change to them is exactly what needs review;
 *   - every path named in the issue resolves to its HUQAN rule, first match
 *     wins, the same way `ocr rules check` resolves it;
 *   - a rule entry carries a real sentence, not a label, so an agent reading it
 *     learns the trap rather than its name.
 *
 * The matcher below is a local re-implementation of the glob forms ocr accepts
 * (`**` across segments, `*` within one) rather than a dependency: the file has
 * to stay loadable by `npm test` on the minimum supported Node, and the two
 * forms used are small enough to state exactly.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const RULE_FILE = path.join(__dirname, '..', '.opencodereview', 'rule.json');

/** Glob match for the forms ocr uses: `**` spans segments (including none), `*` does not. */
function matches(pattern, filePath) {
  const patternParts = pattern.split('/');
  const fileParts = filePath.split('/');

  const walk = (p, f) => {
    if (p === patternParts.length) return f === fileParts.length;
    if (patternParts[p] === '**') {
      // Zero segments (the `lib/**/*.js` case matching `lib/x.js`) or any more.
      return walk(p + 1, f) || (f < fileParts.length && walk(p, f + 1));
    }
    if (f === fileParts.length) return false;
    const segment = patternParts[p];
    const re = new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`, 'u');
    return re.test(fileParts[f]) && walk(p + 1, f + 1);
  };

  return walk(0, 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function loadRules() {
  return JSON.parse(fs.readFileSync(RULE_FILE, 'utf8'));
}

/** The rule ocr would apply: the first entry whose path matches, in file order. */
function resolveRule(rules, filePath) {
  return rules.find(entry => matches(entry.path, filePath)) || null;
}

describe('.opencodereview/rule.json', () => {
  it('keeps test files reviewable, which ocr excludes by default', () => {
    const include = loadRules().include || [];
    assert.ok(
      include.includes('test/**') || include.includes('**/*.test.js'),
      `tests are excluded by default; include must re-admit them. Got: ${JSON.stringify(include)}`,
    );
  });

  it('resolves each trap path from #3197 to its HUQAN rule', () => {
    const { rules } = loadRules();
    // path -> a phrase the matching rule must contain, so a rule that silently
    // stops matching cannot be covered by a neighbour's text.
    const expected = {
      'plugins/company-brain.js': 'manifest',
      'lib/command-parser.js': 'folded to lower case',
      'public/index.html': 'data-i18n',
      'test/cli-conflicts-review.test.js': 'source-contract',
      'lib/mcp/tool-handlers.js': 'workflow contract',
      'lib/mcp-catalog.js': 'workflow contract',
      'lib/graph.js': 'package.json#files',
    };

    for (const [filePath, phrase] of Object.entries(expected)) {
      const rule = resolveRule(rules, filePath);
      assert.ok(rule, `${filePath}: no rule matched, so the trap is invisible to ocr`);
      assert.ok(
        rule.rule.includes(phrase),
        `${filePath}: matched ${rule.path}, whose text does not mention "${phrase}"`,
      );
    }
  });

  it('gives every rule a reason and merges it with the system rules', () => {
    const { rules } = loadRules();
    assert.ok(rules.length > 0, 'an empty rule list would pass the include test and review nothing');
    for (const entry of rules) {
      assert.equal(typeof entry.path, 'string', JSON.stringify(entry));
      assert.ok(entry.path.length > 0, 'an empty path matches nothing');
      assert.equal(entry.merge_system_rule, true,
        `${entry.path}: without merge_system_rule the HUQAN rule would replace the language checklist`);
      // "internal" or "see docs" would pass review forever without anyone
      // rereading it, which is the failure this file exists to prevent.
      assert.ok(entry.rule.length > 120, `${entry.path}: needs the trap in words, not a label`);
    }
  });

  it('does not let a broad rule shadow a more specific one', () => {
    const { rules } = loadRules();
    // `ocr rules check` takes the first match, so a broad rule placed above a
    // specific one silently wins for every path beneath it.
    for (const filePath of ['lib/mcp-catalog.js', 'lib/command-parser.js']) {
      const rule = resolveRule(rules, filePath);
      assert.ok(!rule.path.includes('**'), `${filePath} fell through to the broad ${rule.path}`);
    }
  });
});
