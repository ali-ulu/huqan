'use strict';

/**
 * Falsification test for one claim: the trust policy scores ingested data by
 * the weight of its source.
 *
 * `config/trust-policy.default.json` defines nine weights and a GitHub
 * sub-table, so the claim looks settled by inspection. What is not settled by
 * inspection is whether the values the ingest paths actually emit ever reach
 * those weights. This file measures that, from the emitters rather than from a
 * hand-written list, so a newly added adapter is covered without editing here.
 *
 * The distinction being tested is between a weight that was *chosen* and a
 * weight that was *fallen back to*. Both come out of getDefaultConfidence as a
 * number, and the caller cannot tell them apart -- which is why this can be
 * wrong for a long time without anything failing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTrustPolicy, getDefaultConfidence, applyTrustPolicyToProvenance } = require('../lib/trust-policy');

const REPO_ROOT = path.resolve(__dirname, '..');
const POLICY = loadTrustPolicy();
const FALLBACK = POLICY.fallback && typeof POLICY.fallback.unknown === 'number'
  ? POLICY.fallback.unknown
  : 0.5;

/** The source types provenance-ingest.js is willing to accept. */
function declaredSourceTypes() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'provenance-ingest.js'), 'utf8');
  const block = source.match(/const VALID_SOURCE_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'VALID_SOURCE_TYPES not found in lib/provenance-ingest.js');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

/**
 * The source types the ingest paths actually emit, read out of the emitters.
 *
 * Only `sourceType:` object-literal assignments count. Reading these from the
 * files rather than listing them here is the point: a list would go stale
 * exactly when a new adapter introduces the next unregistered value.
 */
const EMITTERS = [
  'adapters/http-adapter.js',
  'adapters/github-adapter.js',
  'adapters/json-adapter.js',
  'adapters/yaml-adapter.js',
  'adapters/markdown-adapter.js',
  'adapters/pdf-adapter.js',
  'adapters/git-log-adapter.js',
  'plugins/company-brain.js',
];

function emittedSourceTypes() {
  const found = new Map(); // sourceType -> [file:line]
  for (const rel of EMITTERS) {
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // sourceType: 'x'   and   sourceType: opts.sourceType || 'x'
      for (const match of line.matchAll(/sourceType:\s*(?:[^,'"]*\|\|\s*)?'([a-z0-9_-]+)'/gi)) {
        const value = match[1];
        if (!found.has(value)) found.set(value, []);
        found.get(value).push(`${rel}:${index + 1}`);
      }
    });
  }
  return found;
}

test.describe('ingest source types reach the trust policy', () => {
  test('the emitters are still where this test thinks they are', () => {
    // Guards the two extractors above. If either stops matching, every
    // assertion below would pass vacuously.
    const declared = declaredSourceTypes();
    assert.ok(declared.size >= 8, `expected the declared set, got ${[...declared].join(', ')}`);
    assert.ok(declared.has('github'), 'declared set does not contain github');

    const emitted = emittedSourceTypes();
    assert.ok(emitted.size > 0, 'no sourceType literal found in any emitter; the extractor is broken');
  });

  test('every source type an ingest path emits is one provenance-ingest accepts', () => {
    const declared = declaredSourceTypes();
    const emitted = emittedSourceTypes();

    const undeclared = [...emitted.entries()]
      .filter(([value]) => !declared.has(value))
      .map(([value, where]) => `${value} (${where.join(', ')})`);

    assert.deepStrictEqual(undeclared, [],
      'ingest paths emit source types that provenance-ingest.js does not accept:\n  '
      + `${undeclared.join('\n  ')}\n`
      + `accepted: ${[...declared].sort().join(', ')}`);
  });

  test('no emitted source type silently resolves to the unknown fallback', () => {
    // A source type absent from the policy still yields a number. Nothing
    // downstream distinguishes it from a deliberate weight, so the only place
    // this can be caught is here.
    const emitted = emittedSourceTypes();

    const fellThrough = [...emitted.entries()]
      .filter(([value]) => getDefaultConfidence(value, '', POLICY) === FALLBACK
        && !(POLICY.defaults && typeof POLICY.defaults[value] === 'number'))
      .map(([value, where]) => `${value} -> ${FALLBACK} (${where.join(', ')})`);

    assert.deepStrictEqual(fellThrough, [],
      `ingest paths emit source types with no trust policy entry, so every one of them\n`
      + `is scored ${FALLBACK} regardless of how trustworthy the source is:\n  `
      + `${fellThrough.join('\n  ')}`);
  });

  test('the GitHub sub-table is reachable from the GitHub ingest path', () => {
    // The sub-table exists and works. This asserts the adapter's own emitted
    // type is the one that reaches it -- the difference between a policy that
    // is configured and a policy that is applied.
    const emitted = emittedSourceTypes();
    const githubEmits = [...emitted.entries()]
      .filter(([, where]) => where.some((w) => w.startsWith('adapters/github-adapter.js')))
      .map(([value]) => value);

    assert.ok(githubEmits.length > 0, 'github-adapter emits no sourceType literal');

    for (const value of githubEmits) {
      assert.equal(
        getDefaultConfidence(value, 'merged_pr', POLICY),
        POLICY.github.merged_pr,
        `github-adapter emits sourceType "${value}", which does not reach the github `
        + `sub-table: merged_pr scores ${getDefaultConfidence(value, 'merged_pr', POLICY)} `
        + `instead of ${POLICY.github.merged_pr}`,
      );
    }
  });

  test('a fallback confidence is not reported as if the policy had matched', () => {
    // The warning text is the only signal a caller sees. Today an unmatched
    // type produces "auto-filled from trust policy for http", which reads as
    // though the policy carried an entry for http. It does not.
    const result = applyTrustPolicyToProvenance(
      { provenanceId: 'p', sourceRef: 'https://example.org/x', sourceType: 'definitely-not-a-source-type' },
      POLICY,
    );
    const warnings = (result.warnings || []).join(' | ');

    assert.match(warnings, /fallback|unknown|unmatched|not in policy/i,
      `a fallback confidence must say so. observed warnings: ${warnings || '(none)'}`);
  });

  test('positive control: a declared type with a sub-type is scored from the table', () => {
    // Proves the mechanism works, so the failures above are about the ingest
    // paths and not about the policy loader.
    const result = applyTrustPolicyToProvenance(
      { provenanceId: 'p', sourceRef: 'x', sourceType: 'github', sourceSubType: 'merged_pr' },
      POLICY,
    );
    const provenance = result.provenance || result;
    assert.equal(provenance.confidence, POLICY.github.merged_pr);
    assert.notEqual(provenance.confidence, FALLBACK);
  });
});
