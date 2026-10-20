#!/usr/bin/env node
'use strict';

/**
 * Forbid a listed helper from being re-declared outside its canonical module.
 *
 * Why this exists (#4032). `normalizeWorkspaceId` was centralised into
 * `lib/workspace-id.js` by #1099, and #1099 was closed as completed. Nine
 * copies were then written in the following month, each resolving a non-string
 * workspace id to `'default'` where the canonical helper throws. Every module's
 * own tests passed, because they only feed strings — the variants agree there.
 * Nothing in the repository forbade the name from being declared again.
 *
 * `isPlainObject` never had that problem: `test/is-plain-object.test.js`
 * asserts the predicate is defined only once, and the pattern did not return.
 * This generalises that test so the rule survives outside the test file, and
 * so it can be enforced on the whole `lib/` tree by CI rather than by a reader
 * who happens to remember.
 *
 * WHAT THIS DOES NOT DO: it does not decide whether the copies are wrong, and
 * it does not prove a caller routes through the canonical module. It only
 * makes a second declaration visible, which is the step that was missing.
 *
 * The rule is a ratchet, the same shape as `check-file-size.js`:
 *   - a declaration in a file the baseline lists is tolerated, so the check
 *     can land before the cleanup;
 *   - a declaration anywhere else fails, so a tenth copy cannot be added;
 *   - a baselined file that no longer declares the name fails too, so the
 *     entry must be removed once it is cleaned up and the list can only shrink.
 * `--update` rewrites the baseline downward only; it never adds a file.
 */

const fs = require('node:fs');
const path = require('node:path');

const { stripCommentsAndStrings } = require('./binding-site-scan');

const repoRoot = path.resolve(__dirname, '..');
const libDirectory = path.join(repoRoot, 'lib');
const baselinePath = path.join(repoRoot, 'config', 'single-definition-baseline.json');

// A declaration is only a declaration when the name is not a property access
// (`obj.normalizeWorkspaceId`) and sits at a statement or member boundary.
const LEADING = String.raw`(?:^|[\s{;,(])`;

// A parenthesised parameter list. Built to a fixed depth because a default
// parameter can itself contain parentheses (`value = getDefault()`), which a
// flat `[^()]*` would reject and so miss the method shorthand entirely.
const parameterGroup = (depth) => (depth === 0 ? '[^()]*' : `(?:[^()]|\\(${parameterGroup(depth - 1)}\\))*`);
const PARAMETERS = `\\(${parameterGroup(2)}\\)`;

/**
 * Every declaration shape a rule must catch, for one helper name.
 *
 * Shared by the rules below so a name cannot be guarded more weakly than the
 * others: the shapes a matcher misses are exactly how a duplicate survives.
 */
function declarationPatterns(name) {
  return [
    // function declaration / expression: `function f(` / `async function f(`
    new RegExp(`${LEADING}(?:async\\s+)?function\\s+${name}\\s*\\(`),
    // assignment or object property: `f = (`, `f = async (`, `f = function`,
    // `f: (`, `f: async function`, and the single-parameter arrow `f = v =>`
    // — the `(`/`function`/`=>` is what separates a definition from an alias
    // (`f = require('...').f`).
    new RegExp(`${LEADING}${name}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`),
    // method shorthand: `f(x) {`, including a default parameter.
    new RegExp(`${LEADING}${name}\\s*${PARAMETERS}\\s*\\{`),
  ];
}

/**
 * One entry per helper that must have exactly one declaration.
 *
 * `canonical` is the file allowed to declare it. `patterns` match a
 * declaration of any shape and never a call site or an import. They run
 * against the whole file with comments and string literals blanked and all
 * whitespace collapsed, so a declaration split across lines is seen whole.
 */
const RULES = [
  {
    name: 'normalizeWorkspaceId',
    canonical: 'lib/workspace-id.js',
    patterns: declarationPatterns('normalizeWorkspaceId'),
  },
  {
    // #4116: the predicate `test/is-plain-object.test.js` has pinned since
    // f20e22d3, moved into the gate so it is enforced by CI rather than by a
    // reader who remembers -- a copy in lib/cognition/cognition-config.js
    // reached main through a PR whose impact plan never selected that test.
    name: 'isPlainObject',
    canonical: 'lib/is-plain-object.js',
    patterns: declarationPatterns('isPlainObject'),
  },
];

function collectJavaScriptFiles(directory, carry = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScriptFiles(target, carry);
    else if (entry.isFile() && entry.name.endsWith('.js')) carry.push(target);
  }
  return carry;
}

/**
 * Does this source declare the helper in any supported shape?
 *
 * Comments and string literals are blanked (length-preserving) before matching
 * so a documented example, a `require('...')` string, or a `'normalizeWorkspaceId'`
 * literal cannot be mistaken for a declaration. All whitespace is then collapsed
 * so a declaration split across lines is seen as one statement. The patterns
 * themselves never match a call site or a destructured import.
 */
function declaresAny(source, patterns) {
  const normalized = stripCommentsAndStrings(source).replace(/\s+/g, ' ');
  return patterns.some((pattern) => pattern.test(normalized));
}

function readBaseline(baselineFile = baselinePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    return {
      rules: parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : {},
      reasons: parsed.reasons && typeof parsed.reasons === 'object' ? parsed.reasons : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { rules: {}, reasons: {} };
    throw new Error(`cannot read ${path.relative(repoRoot, baselineFile)}: ${error.message}`);
  }
}

function scanRule(rule, directory = libDirectory) {
  return collectJavaScriptFiles(directory)
    .filter((file) => declaresAny(fs.readFileSync(file, 'utf8'), rule.patterns))
    .map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
    .sort();
}

function collectViolations(baseline) {
  const violations = [];
  for (const rule of RULES) {
    const found = scanRule(rule);
    const allowed = new Set((baseline.rules[rule.name] || []).filter((file) => file !== rule.canonical));

    if (!found.includes(rule.canonical)) {
      violations.push({
        kind: 'missing-canonical',
        rule: rule.name,
        message: `${rule.canonical} no longer declares ${rule.name}; the rule is stale, fix RULES in scripts/check-single-definition.js`,
      });
    }
    for (const file of found) {
      if (file === rule.canonical || allowed.has(file)) continue;
      violations.push({
        kind: 'new-declaration',
        rule: rule.name,
        message: `${file} declares ${rule.name}; it must call ${rule.canonical} instead`,
      });
    }
    for (const file of allowed) {
      if (!found.includes(file)) {
        violations.push({
          kind: 'stale-baseline',
          rule: rule.name,
          message: `${file} is listed in the baseline but no longer declares ${rule.name}; remove it with --update`,
        });
      } else if (!String(baseline.reasons[file] || '').trim()) {
        // A tolerated duplicate is a human judgement. Recorded without a reason
        // it is indistinguishable from an oversight, which is how the copies
        // came back in the first place.
        violations.push({
          kind: 'unreasoned-baseline',
          rule: rule.name,
          message: `${file} is tolerated but has no entry in "reasons"; every exception must state why`,
        });
      }
    }
  }
  return violations;
}

function writeBaseline(baseline) {
  const next = { schemaVersion: 1, reasons: {}, rules: {} };
  for (const rule of RULES) {
    const allowed = (baseline.rules[rule.name] || [])
      .filter((file) => file !== rule.canonical)
      .filter((file) => fs.existsSync(path.join(repoRoot, file)))
      .filter((file) => declaresAny(fs.readFileSync(path.join(repoRoot, file), 'utf8'), rule.patterns))
      .sort();
    next.rules[rule.name] = [rule.canonical, ...allowed];
    for (const file of allowed) {
      if (String(baseline.reasons[file] || '').trim()) next.reasons[file] = baseline.reasons[file];
    }
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main() {
  const update = process.argv.includes('--update');
  const baseline = readBaseline();
  const violations = collectViolations(baseline);

  // --update narrows only: a new declaration is never written into the baseline.
  const blocked = violations.filter((violation) => violation.kind === 'new-declaration');
  if (update && blocked.length === 0) {
    const next = writeBaseline(baseline);
    const total = Object.values(next.rules).reduce((sum, files) => sum + files.length - 1, 0);
    console.log(`check:single-definition — baseline rewritten; ${total} tolerated declaration(s).`);
    return 0;
  }

  if (violations.length === 0) {
    const tolerated = RULES.reduce(
      (sum, rule) => sum + (baseline.rules[rule.name] || []).filter((f) => f !== rule.canonical).length,
      0,
    );
    console.log(
      `check:single-definition — no new declaration; ${tolerated} baselined duplicate(s) remain (see #4032).`,
    );
    return 0;
  }

  console.error(`check:single-definition — ${violations.length} violation(s):\n`);
  for (const violation of violations) console.error(`  [${violation.kind}] ${violation.message}`);
  console.error('\nRoute the declaration through the canonical module, or — if it is deliberate,');
  console.error('like lib/cross-workspace-access-gate.js returning \'\' — say so in a comment and');
  console.error('add the file to config/single-definition-baseline.json with the reason in the PR.');
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  RULES,
  declaresAny,
  collectJavaScriptFiles,
  scanRule,
  collectViolations,
  readBaseline,
};
