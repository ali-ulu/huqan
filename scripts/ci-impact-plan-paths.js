'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, discoverTestFiles } = require('./ci-shard-manifest');
const { DOC_ONLY_PATTERNS } = require('./ci-impact-rules');

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const value = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*') {
      if (value[index + 1] === '*') {
        if (value[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPattern(value, pattern) {
  return globToRegExp(pattern).test(normalizePath(value));
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function isTestFile(file) {
  const normalized = normalizePath(file);
  const base = path.posix.basename(normalized);
  return normalized.startsWith('test/')
    || base.endsWith('.test.js')
    || base.endsWith('.spec.js')
    || base.endsWith('-test.js')
    || base.endsWith('_test.js')
    || base.startsWith('test-')
    || base === 'test.js';
}

function isRuntimeOrTestFile(file) {
  const normalized = normalizePath(file);
  if (isTestFile(normalized)) return true;
  if (matchesAny(normalized, DOC_ONLY_PATTERNS)) return false;
  if (matchesAny(normalized, [
    'package.json', 'package-lock.json', 'plugins/**', 'lib/**', 'nlp/**',
    'packages/**', 'migrations/**', 'schemas/**', 'adapters/**', 'scripts/**',
    'benchmarks/**', 'bin/**',
  ])) return true;
  if (normalized.includes('/')) return false;
  return normalized.endsWith('.js');
}

function discoverKnownTests(root = REPO_ROOT) {
  return discoverTestFiles(root).map(normalizePath).sort();
}

function addMatchingTests(target, reasons, knownTests, patterns, reason) {
  for (const file of knownTests) {
    if (!matchesAny(file, patterns)) continue;
    target.add(file);
    if (!reasons.has(file)) reasons.set(file, []);
    reasons.get(file).push(reason);
  }
}

function readChangedFiles({ root = REPO_ROOT, base, head, changedFiles } = {}) {
  if (Array.isArray(changedFiles)) return changedFiles.map(normalizePath).filter(Boolean).sort();
  if (!base || !head) throw new Error('base and head are required when changedFiles is not provided');
  const result = spawnSync('git', ['diff', '--name-only', base, head], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git diff exited with ${result.status}`);
  return result.stdout.split('\n').map(normalizePath).filter(Boolean).sort();
}

module.exports = { normalizePath, globToRegExp, matchesPattern, matchesAny,
  isRuntimeOrTestFile, discoverKnownTests, addMatchingTests, readChangedFiles };
