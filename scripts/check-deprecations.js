#!/usr/bin/env node
'use strict';

/**
 * Deprecation policy gate (issue #2649, task M4).
 *
 * Scans JS/TS declaration sources for `@deprecated` JSDoc tags and checks the
 * rules in DEPRECATION_POLICY.md: migration hint present, runtime warning for
 * non-root callables, removal major not already overdue.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'config', 'deprecation-allowlist.json');

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'docs', 'test', 'benchmarks', 'examples']);

/**
 * @param {string} root
 * @param {string[]} acc
 */
function collectSourceFiles(root, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (/\.(js|d\.ts)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      // The gate's own file documents the policy and mentions @deprecated in
      // prose; scanning it would false-fail on those mentions.
      if (entry.name.startsWith('check-deprecations')) continue;
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @param {string} source
 * @returns {Array<{ tag: string, index: number, line: number, body: string }>}
 */
function findDeprecatedTags(source) {
  const tags = [];
  const re = /\/\*\*[\s\S]*?@deprecated\b([\s\S]*?)\*\//g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const line = before.split(/\r?\n/).length;
    tags.push({ tag: match[0], body: match[1], index: match.index, line });
  }
  return tags;
}

/**
 * @param {string} tagBody
 */
function hasMigrationHint(tagBody) {
  return /\buse\b/i.test(tagBody) || /\breplaced by\b/i.test(tagBody) || /\bsee\b/i.test(tagBody);
}

/**
 * @param {string} tagBody
 * @returns {number|null}
 */
function removalMajor(tagBody) {
  const m = tagBody.match(/removed in v?(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Best-effort symbol name after the tag (exports.X or module.exports.X).
 * @param {string} source
 * @param {number} tagEnd
 */
function symbolAfterTag(source, tagEnd) {
  const slice = source.slice(tagEnd, tagEnd + 200);
  const m = slice.match(/(?:module\.)?exports\.(\w+)\s*=/);
  return m ? m[1] : null;
}

/**
 * @param {{ root?: string, packageVersion?: string }} [opts]
 */
function checkDeprecations(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const pkgPath = path.join(root, 'package.json');
  const packageVersion = opts.packageVersion
    || (fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version : '0.0.0');
  const currentMajor = Number(String(packageVersion).split('.')[0]) || 0;

  let allowlist = { silentRootAliases: [] };
  const allowPath = path.join(root, 'config', 'deprecation-allowlist.json');
  if (fs.existsSync(allowPath)) {
    allowlist = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
  }

  const silent = new Set(
    (allowlist.silentRootAliases || []).map((e) => `${e.file}::${e.symbol}`),
  );

  const files = collectSourceFiles(root);
  const violations = [];
  let tagCount = 0;

  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const tags = findDeprecatedTags(source);
    if (!tags.length) continue;

    const hasWarn = /process\.emitWarning|console\.warn/.test(source);

    for (const tag of tags) {
      tagCount += 1;
      const symbol = symbolAfterTag(source, tag.index + tag.tag.length);
      const key = `${rel}::${symbol || ''}`;

      if (!hasMigrationHint(tag.body)) {
        violations.push(`${rel}:${tag.line}: @deprecated missing migration hint (Use … / replaced by …)`);
      }

      const major = removalMajor(tag.body);
      if (major !== null && currentMajor >= major) {
        violations.push(`${rel}:${tag.line}: @deprecated claims removal in v${major}.0 but package is still ${packageVersion}`);
      }

      const isSilentRoot = silent.has(key) || (rel === 'index.js' && silent.has(`index.js::${symbol}`));
      if (!isSilentRoot && !hasWarn && !rel.endsWith('.d.ts')) {
        if (rel !== 'index.js' && rel !== 'index.d.ts') {
          violations.push(`${rel}:${tag.line}: @deprecated callable surface has no process.emitWarning/console.warn in file`);
        }
      }
    }
  }

  const lines = [`Deprecation check: ${tagCount} @deprecated tag(s) across ${files.length} source file(s)`];
  if (violations.length) {
    lines.push(`FAIL: ${violations.length} policy violation(s):`);
    for (const v of violations) lines.push(`  - ${v}`);
  } else {
    lines.push('Deprecation policy passed');
  }

  return {
    ok: violations.length === 0,
    tagCount,
    violations,
    report: lines.join('\n'),
  };
}

function main() {
  const result = checkDeprecations();
  if (result.ok) {
    console.log(result.report);
    return 0;
  }
  console.error(result.report);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkDeprecations, main };
