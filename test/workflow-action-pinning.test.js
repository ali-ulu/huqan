const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const SHA_REF = /^[0-9a-f]{40}$/;

/**
 * Action references that may stay unpinned, with the reason. Empty by design:
 * an exception belongs here, in review, rather than being silently tolerated
 * by the matcher (#751).
 */
const DOCUMENTED_EXCEPTIONS = Object.freeze(new Map());

function workflowFiles() {
  return fs.readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(WORKFLOW_DIR, name));
}

/** Every `uses:` reference, with the file and line that declared it. */
function actionReferences() {
  const references = [];
  for (const file of workflowFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (!match) return;
      references.push({
        file: path.basename(file),
        line: index + 1,
        reference: match[1],
      });
    });
  }
  return references;
}

describe('workflow actions are pinned to immutable commits (#751)', () => {
  it('finds action references to check', () => {
    assert.ok(actionReferences().length > 0, 'no `uses:` references found');
  });

  it('every action is pinned to a full commit SHA', () => {
    const unpinned = [];
    for (const { file, line, reference } of actionReferences()) {
      // Local composite actions (./path) carry no supply-chain risk.
      if (reference.startsWith('./')) continue;
      if (DOCUMENTED_EXCEPTIONS.has(reference)) continue;

      const version = reference.split('@')[1];
      if (!version || !SHA_REF.test(version)) {
        unpinned.push(`${file}:${line} ${reference}`);
      }
    }
    assert.deepStrictEqual(
      unpinned,
      [],
      'mutable action references: a retargeted tag changes privileged CI code with no repository diff',
    );
  });

  it('each pinned action still records its human-readable tag', () => {
    const missingComment = [];
    for (const file of workflowFiles()) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
        if (!match || match[1].startsWith('./')) return;
        const version = match[1].split('@')[1];
        if (!version || !SHA_REF.test(version)) return;
        if (!/#\s*\S+/.test(line)) {
          missingComment.push(`${path.basename(file)}:${index + 1}`);
        }
      });
    }
    assert.deepStrictEqual(missingComment, [], 'pinned actions must keep a readable tag comment');
  });

  it('the container base image is digest-pinned (#753)', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    const froms = dockerfile.split('\n').filter((line) => /^FROM\s/.test(line));
    assert.ok(froms.length >= 2, 'expected a multi-stage Dockerfile');

    const digests = new Set();
    for (const line of froms) {
      assert.match(line, /@sha256:[0-9a-f]{64}/, `base image is not digest-pinned: ${line}`);
      digests.add(line.match(/@(sha256:[0-9a-f]{64})/)[1]);
    }
    assert.strictEqual(digests.size, 1,
      'build and runtime stages should share one reviewed digest unless documented otherwise');
  });

  it('the container base image runs a Node major CI actually tests (#3013)', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
    const imageMajors = new Set();
    for (const line of dockerfile.split('\n')) {
      const match = line.match(/^FROM\s+node:(\d+)-/);
      if (match) imageMajors.add(Number(match[1]));
    }
    assert.ok(imageMajors.size >= 1, 'no node base image found in the Dockerfile');

    const ciMajors = new Set();
    for (const file of workflowFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/node-version:\s*(?:'|"|\[)?\s*(\d{2})\b/g)) {
        ciMajors.add(Number(match[1]));
      }
      for (const match of text.matchAll(/node-version:\s*\[([^\]]+)\]/g)) {
        for (const item of match[1].split(',')) ciMajors.add(Number(item.trim()));
      }
    }
    assert.ok(ciMajors.size > 0, 'no CI node-version matrix found');

    for (const major of imageMajors) {
      assert.ok(ciMajors.has(major),
        `the image runs Node ${major} but CI only tests ${[...ciMajors].sort().join(', ')}; ` +
        'pin a major the suite actually gates (#3013)');
      assert.strictEqual(major % 2, 0,
        `Node ${major} is a non-LTS (odd) line; pin an LTS major instead (#3013)`);
    }
  });

  it('the privileged security workflow installs an exact semgrep version', () => {
    const security = fs.readFileSync(path.join(WORKFLOW_DIR, 'security.yml'), 'utf8');
    const install = security.match(/pip install[^\n]*semgrep[^\n]*/);
    assert.ok(install, 'semgrep install line not found');
    assert.match(install[0], /semgrep==\d+\.\d+\.\d+/, 'semgrep must be pinned to an exact version');
    assert.doesNotMatch(install[0], /semgrep[<>]=/, 'a version range lets an unreviewed release run');
  });
});
