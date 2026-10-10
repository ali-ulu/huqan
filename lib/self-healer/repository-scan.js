'use strict';

/**
 * Self-Healer SH-2: the autonomous, audit-only repository scan.
 *
 * Until this module the finding pipeline (finding-schema -> finding-classifier
 * -> safety-decision -> audit-runner) only ever ran on checks a caller handed
 * it. This is the missing input: a bounded, local, read-only walk that turns
 * real repository observations into raw findings, so the rest of the machinery
 * runs on the repository instead of on a hand-fed list.
 *
 * Boundary (docs/v0.9.2-self-healer-roadmap.md, SH-2): read and report only.
 * No branch, no patch, no memory write, no PR, and no autonomous apply. The
 * scan proposes; a human reviews. It reads bytes and returns findings -- the
 * only filesystem calls are `statSync` and `readFileSync`.
 *
 * Findings feed a proposal pipeline, so the detectors are deliberately
 * high-precision: a noisy detector spends human attention. Every detector here
 * fires on a marker that is unambiguous in source text (#3800).
 */

const fs = require('node:fs');
const path = require('node:path');

const { listFilesWithinRoot } = require('../safe-file-walk');
const { classifyRawFinding } = require('./finding-classifier');
const { normalizeWorkspaceId } = require('../workspace-id');

// Heavy trees a repo scan must not pay to walk. Naming a directory here is a
// traversal boundary, not a match filter: the walker never descends into it.
const DEFAULT_PRUNED_DIRECTORIES = Object.freeze([
  'node_modules',
  '.git',
  '.cache',
  'coverage',
  'dist',
  'build',
  '.archify',
  '.openhands',
]);

const DEFAULT_SCAN_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024,
  maxFindings: 200,
});

const SCAN_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs', '.ts', '.md', '.json', '.yml', '.yaml']);

const CONFLICT_MARKER_PATTERN = /^(<{7}|={7}|>{7})(\s|$)/m;
// Require the marker to open a note -- followed by a colon, an open paren, or a
// hyphen. A bare marker word also appears inside ordinary prose, so the looser
// form would report prose (and this comment) as deferred work.
const TODO_MARKER_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b\s*[:(-]/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// Fixture keys live under tests; a scan that flagged them would report the same
// files forever and train reviewers to ignore the detector. A test path is
// either under a test/fixture directory or a `*.test.js` / `*.spec.ts` file.
const TEST_DIRECTORY_PATTERN = /(^|\/)(test|tests|__tests__|fixtures)\//;
const TEST_FILENAME_PATTERN = /\.(test|spec)\.[cm]?[jt]s$/;

function normalizeString(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function isDocsPath(relPath) {
  return /(^|\/)docs?\//i.test(relPath) || /\.(md|mdx|markdown|rst|txt)$/i.test(relPath);
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function hasScanExtension(relPath) {
  return SCAN_EXTENSIONS.includes(path.extname(relPath).toLowerCase());
}

function validateScanOptions(opts = {}) {
  const errors = [];
  const repoRoot = normalizeString(opts.repoRoot);
  if (!repoRoot) {
    errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot is required' });
  } else {
    if (!path.isAbsolute(repoRoot)) {
      errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot must be an absolute path' });
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(repoRoot)) {
      errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot must not contain traversal segments' });
    }
  }
  const maxFindings = opts.maxFindings;
  if (maxFindings !== undefined && (!Number.isSafeInteger(maxFindings) || maxFindings <= 0)) {
    errors.push({ field: 'maxFindings', code: 'VALIDATION_ERROR', message: 'maxFindings must be a positive safe integer' });
  }
  const maxFileBytes = opts.maxFileBytes;
  if (maxFileBytes !== undefined && (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)) {
    errors.push({ field: 'maxFileBytes', code: 'VALIDATION_ERROR', message: 'maxFileBytes must be a positive safe integer' });
  }
  return { ok: errors.length === 0, errors };
}

function findingBase(relPath, workspaceId) {
  return {
    workspaceId,
    affectedFiles: [relPath],
    evidence: [],
    riskFlags: [],
    suggestedTests: [],
    suggestedFix: { summary: '', allowedFiles: [relPath], forbiddenFiles: [], risk: 'low' },
  };
}

function firstMarkerLine(text, pattern) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return 1;
}

function detectConflictMarkers(relPath, text, workspaceId) {
  if (!CONFLICT_MARKER_PATTERN.test(text)) return [];
  const base = findingBase(relPath, workspaceId);
  return [{
    ...base,
    kind: 'bug',
    confidence: 0.9,
    title: 'Unresolved merge-conflict markers',
    summary: `${relPath} contains VCS conflict markers and cannot be a valid source file.`,
    evidence: [{
      type: 'file',
      ref: relPath,
      detail: `conflict marker at line ${firstMarkerLine(text, CONFLICT_MARKER_PATTERN)}`,
    }],
  }];
}

function detectTodoMarkers(relPath, text, workspaceId) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length && hits.length < 3; index += 1) {
    const match = lines[index].match(TODO_MARKER_PATTERN);
    if (match) hits.push({ marker: match[1], line: index + 1 });
  }
  if (hits.length === 0) return [];
  const base = findingBase(relPath, workspaceId);
  return [{
    ...base,
    kind: isDocsPath(relPath) ? 'stale_docs' : 'bug',
    confidence: 0.55,
    title: 'Deferred-work marker left in source',
    summary: `${relPath} carries ${hits.map((hit) => `${hit.marker} at line ${hit.line}`).join(', ')}.`,
    evidence: hits.map((hit) => ({
      type: 'file',
      ref: relPath,
      detail: `${hit.marker} marker at line ${hit.line}`,
    })),
  }];
}

function detectPrivateKeyMaterial(relPath, text, workspaceId) {
  if (TEST_DIRECTORY_PATTERN.test(relPath) || TEST_FILENAME_PATTERN.test(relPath)) return [];
  if (!PRIVATE_KEY_PATTERN.test(text)) return [];
  const base = findingBase(relPath, workspaceId);
  return [{
    ...base,
    kind: 'security',
    confidence: 0.95,
    title: 'Private key material committed outside tests',
    summary: `${relPath} contains a PEM private key block and is not a test or fixture path.`,
    evidence: [{
      type: 'file',
      ref: relPath,
      detail: `private key block at line ${firstMarkerLine(text, PRIVATE_KEY_PATTERN)}`,
    }],
    riskFlags: ['canonical_write'],
  }];
}

const DETECTORS = Object.freeze([
  detectConflictMarkers,
  detectTodoMarkers,
  detectPrivateKeyMaterial,
]);

/**
 * Walks `repoRoot` read-only and returns normalized findings. Deterministic:
 * `listFilesWithinRoot` sorts, detectors emit in a fixed order, and the caller
 * (audit-runner) sorts findings by id.
 *
 * @param {object} input { workspaceId, repoRoot, maxFileBytes, maxFindings, prunedDirectories }
 * @returns {object} scan result with raw normalized findings
 */
function runRepositoryScan(input = {}, opts = {}) {
  const options = {
    workspaceId: normalizeWorkspaceId(input.workspaceId ?? opts.workspaceId),
    repoRoot: normalizeString(input.repoRoot ?? opts.repoRoot),
    maxFileBytes: input.maxFileBytes ?? opts.maxFileBytes ?? DEFAULT_SCAN_LIMITS.maxFileBytes,
    maxFindings: input.maxFindings ?? opts.maxFindings ?? DEFAULT_SCAN_LIMITS.maxFindings,
    prunedDirectories: Array.isArray(input.prunedDirectories)
      ? input.prunedDirectories.map(normalizeString).filter(Boolean)
      : [...DEFAULT_PRUNED_DIRECTORIES],
  };

  const validation = validateScanOptions(options);
  if (!validation.ok) {
    const error = new Error('Invalid scan options');
    error.validation = validation;
    throw error;
  }

  const pruned = new Set(options.prunedDirectories);
  const files = listFilesWithinRoot(options.repoRoot, {
    rootPath: options.repoRoot,
    matchesFile: (absFile) => hasScanExtension(absFile) && !pruned.has(path.basename(absFile)),
    pruneDirectory: (name) => pruned.has(name),
  });

  const rawFindings = [];
  let filesScanned = 0;
  let filesSkipped = 0;

  for (const absFile of files) {
    let text;
    try {
      // One descriptor for both the size check and the read, so the file that
      // is measured is the file that is read. A statSync-then-readFileSync pair
      // reopens by path and leaves a window for the file to change between the
      // two (CodeQL js/file-system-race).
      const descriptor = fs.openSync(absFile, 'r');
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size > options.maxFileBytes) {
          filesSkipped += 1;
          continue;
        }
        text = fs.readFileSync(descriptor, 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (_) {
      filesSkipped += 1;
      continue;
    }
    filesScanned += 1;
    const relPath = toPosix(path.relative(options.repoRoot, absFile));
    for (const detector of DETECTORS) {
      for (const raw of detector(relPath, text, options.workspaceId)) {
        rawFindings.push(classifyRawFinding(raw, { workspaceId: options.workspaceId }));
      }
    }
  }

  const findings = rawFindings
    .slice(0, options.maxFindings)
    .sort((a, b) => a.findingId.localeCompare(b.findingId));

  return {
    ok: true,
    mode: 'audit_only',
    workspaceId: options.workspaceId,
    repoRoot: options.repoRoot,
    filesScanned,
    filesSkipped,
    findingCount: findings.length,
    truncated: rawFindings.length > options.maxFindings,
    prunedDirectories: [...options.prunedDirectories],
    maxFileBytes: options.maxFileBytes,
    maxFindings: options.maxFindings,
    findings,
  };
}

module.exports = {
  DEFAULT_PRUNED_DIRECTORIES,
  DEFAULT_SCAN_LIMITS,
  SCAN_EXTENSIONS,
  DETECTORS,
  validateScanOptions,
  runRepositoryScan,
};
