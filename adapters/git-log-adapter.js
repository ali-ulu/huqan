const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolvePathWithinRoot } = require('../lib/path-safety');

// Record/field separators from the ASCII control range, chosen because they
// essentially never appear in real commit messages, so a single git-log
// invocation can be split back into structured commits without a second
// process per commit.
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';
const DEFAULT_MAX_COMMITS = 200;

function toAbs(p) {
  return path.resolve(String(p || ''));
}

/**
 * Parses the raw stdout of `git log --pretty=format:%H\x1f%an\x1f%ae\x1f%aI
 * \x1f%s\x1f%b\x1e` into structured commit records. Pure and git-free, so it
 * is testable without spawning a process.
 */
function parseGitLog(rawOutput) {
  const text = String(rawOutput || '');
  if (!text.trim()) return [];
  return text.split(RECORD_SEP)
    .map((record) => record.replace(/^\s+/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash, authorName, authorEmail, date, subject, ...bodyParts] = record.split(FIELD_SEP);
      return {
        hash: (hash || '').trim(),
        shortHash: (hash || '').trim().slice(0, 12),
        authorName: (authorName || '').trim(),
        authorEmail: (authorEmail || '').trim(),
        date: (date || '').trim(),
        subject: (subject || '').trim(),
        body: (bodyParts.join(FIELD_SEP) || '').trim(),
      };
    })
    .filter((commit) => commit.hash);
}

/**
 * Checks that absPath is itself a git repository root -- NOT that it is
 * nested somewhere under one. `git rev-parse --git-dir` walks up through
 * parent directories looking for a `.git`, so running it against an
 * arbitrary empty directory would report "yes" whenever any ancestor
 * happens to be a repo (e.g. the OS temp dir living under a user home
 * directory that is itself version-controlled). Checking for a `.git` entry
 * directly inside absPath avoids that false positive entirely.
 */
function isGitRepo(absPath) {
  return fs.existsSync(path.join(absPath, '.git'));
}

/**
 * Runs `git log` against a validated, on-disk repository and returns
 * structured commits. repoPath must resolve inside options.rootPath (same
 * traversal/symlink guard every other adapter uses) and must itself be a
 * git repository -- both are checked before any process is spawned. Every
 * git argument is a fixed literal or a value passed via execFileSync's argv
 * array, never shell-interpolated, so there is no command-injection surface
 * regardless of what options.since/branch/pathFilter contain.
 */
function getCommits(repoPath, options = {}) {
  const rootPath = options.rootPath || options.allowedRoot || options.workspaceRoot;
  if (!rootPath) {
    throw new Error('rootPath is required');
  }

  const absRoot = path.resolve(String(rootPath));
  const absRepo = resolvePathWithinRoot(absRoot, repoPath);
  if (!fs.statSync(absRepo).isDirectory()) {
    throw new Error(`git-log-adapter: ${absRepo} is not a directory`);
  }
  if (!isGitRepo(absRepo)) {
    const err = new Error(`git-log-adapter: ${absRepo} is not a git repository`);
    err.code = 'NOT_A_GIT_REPO';
    throw err;
  }

  const maxCommits = Number.isInteger(options.maxCommits) && options.maxCommits > 0
    ? options.maxCommits
    : DEFAULT_MAX_COMMITS;

  const args = [
    '-C', absRepo,
    'log',
    `--max-count=${maxCommits}`,
    `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`,
  ];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.branch) args.push(String(options.branch));
  if (options.pathFilter) args.push('--', String(options.pathFilter));

  const raw = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return parseGitLog(raw).map((commit) => ({ ...commit, repoPath: absRepo }));
}

function ingestGitLog(repoPath, options = {}) {
  const commits = getCommits(repoPath, options);
  const entries = commits.map((commit) => {
    const content = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
    return {
      entryKey: commit.shortHash,
      filePath: commit.repoPath,
      content: content.trim(),
      sourceRef: `git:${commit.repoPath}:${commit.hash}`,
      commit,
    };
  }).filter((entry) => entry.content);

  return {
    repoPath: commits.length ? commits[0].repoPath : toAbs(repoPath),
    commits,
    entries,
  };
}

function ingestAndLearn(repoPath, kernel, options = {}) {
  const result = ingestGitLog(repoPath, options);
  const learned = [];
  for (const entry of result.entries) {
    const provenance = {
      provenanceId: `git-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'git-log-adapter',
      sourceRef: entry.sourceRef,
      sourceType: 'git-log',
      actor: options.actor || 'git-log-adapter',
      timestamp: entry.commit.date || new Date().toISOString(),
    };
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType: 'git-log', sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  parseGitLog,
  isGitRepo,
  getCommits,
  ingestGitLog,
  ingestAndLearn,
};
