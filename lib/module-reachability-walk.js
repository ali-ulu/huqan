'use strict';

// #2211: the repository walk behind module reachability: relative require
// resolution, the symlink-safe source file collection (#744) and the require
// graph traversal. The entry points and the NOT_YET_WIRED ledger stay in
// module-reachability.js, where scripts/check-dead-code.js reads them.

const fs = require('node:fs');
const path = require('node:path');

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * True when `candidate` really lives under `root` after both are canonicalized.
 *
 * Comparing the lexical path is not enough: the whole point is that a symlink's
 * name sits inside the repository while its target does not.
 */
function isWithinRoot(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Walk the repository for source files, without leaving it and without
 * revisiting a directory (#744).
 *
 * The previous walker used fs.statSync(), which follows symlinks, and kept no
 * record of where it had been. A checked-out symlink pointing at an external
 * directory was therefore treated as an ordinary directory and scanned — this
 * module is repository/CI architecture enforcement, so that meant reading host
 * paths that were never part of the repository — and an in-tree symlink cycle
 * such as `a/loop -> ..` recursed until the stack gave out.
 *
 * lstat() identifies the link itself rather than its target; realpath() decides
 * whether the target is still inside the repository; and the visited set is
 * keyed on the real path so a cycle terminates and an aliased directory is
 * walked once.
 */
function collectSourceFiles(root, dir = root, acc = [], visited = null) {
  const skip = new Set(['node_modules', '.git', 'docs', 'test', 'coverage']);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (_) {
    return acc;
  }
  const seenDirectories = visited || new Set();

  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (_) {
    return acc;
  }
  if (!isWithinRoot(realRoot, realDir)) return acc;
  if (seenDirectories.has(realDir)) return acc;
  seenDirectories.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return acc;
  }

  for (const name of entries) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);

    let linkStat;
    try {
      linkStat = fs.lstatSync(full);
    } catch (_) {
      continue;
    }

    if (linkStat.isSymbolicLink()) {
      // Resolve before deciding anything: a link may name a directory outside
      // the repository, or one already walked under its real name.
      let realEntry;
      try {
        realEntry = fs.realpathSync(full);
      } catch (_) {
        continue;
      }
      if (!isWithinRoot(realRoot, realEntry)) continue;
      let realStat;
      try {
        realStat = fs.statSync(realEntry);
      } catch (_) {
        continue;
      }
      if (realStat.isDirectory()) {
        collectSourceFiles(root, realEntry, acc, seenDirectories);
      } else if (name.endsWith('.js') && !name.endsWith('.test.js') && !acc.includes(realEntry)) {
        acc.push(realEntry);
      }
      continue;
    }

    if (linkStat.isDirectory()) {
      collectSourceFiles(root, full, acc, seenDirectories);
    } else if (name.endsWith('.js') && !name.endsWith('.test.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function walkRequires(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  for (const match of source.matchAll(REQUIRE_PATTERN)) {
    const resolved = resolveRequire(file, match[1]);
    if (resolved) walkRequires(resolved, seen);
  }
}

const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * #2505 A: the require edge map behind dependency fan-in. Same resolution and
 * the same skipped directories as collectSourceFiles, but keeps
 * who-requires-whom so a caller can count dependents without re-walking per
 * file. Keys and values are absolute paths; values are deduplicated in
 * first-seen order. Unreadable files map to an empty dependency list, never
 * throw.
 */
function collectRequireEdges(root) {
  const edges = new Map();
  for (const file of collectSourceFiles(root)) {
    const deps = [];
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_) {
      edges.set(file, deps);
      continue;
    }
    for (const match of source.matchAll(REQUIRE_PATTERN)) {
      const resolved = resolveRequire(file, match[1]);
      if (resolved && !deps.includes(resolved)) deps.push(resolved);
    }
    edges.set(file, deps);
  }
  return edges;
}

module.exports = {
  collectRequireEdges,
  collectSourceFiles,
  walkRequires,
};
