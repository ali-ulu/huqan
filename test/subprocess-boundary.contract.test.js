'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { buildCoverageManifest } = require('../scripts/enforcement-coverage');

/**
 * The guard's outermost limit, pinned as behaviour rather than prose.
 *
 * `docs/external-action-guard.md` states it under "Bilinen sınırlar": the guard
 * does not see the tool calls of a process it approved. That sentence is true
 * and it is the single most consequential thing to know about what "protected"
 * means here -- but a sentence in a document drifts, and that document is not
 * even published with the package (`package.json#files` ships one seed file out
 * of docs/).
 *
 * So this demonstrates it instead. If somebody ever closes the boundary, this
 * test fails and tells them the disclosure is now wrong -- which is the right
 * failure to get.
 */

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-subprocess-'));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function decide(args, toolName, workspaceRoot) {
  return evaluateExternalAction({
    invocationId: 'subprocess-boundary',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName,
    args,
    cwd: workspaceRoot,
    workspaceRoot,
  }, { receiptWriter: { append() {} }, allowedCommands: ['node'] });
}

test('an approved command runs, and what it then does never reaches the guard', () => {
  // The demonstration, end to end on a real process. This is not a bug report:
  // it is the boundary the product has, measured, so that "protected" is not
  // read as more than it is.
  const { dir, cleanup } = workspace();
  try {
    const outside = path.join(os.tmpdir(), `huqan-outside-${process.pid}.txt`);
    const agent = path.join(dir, 'agent.js');
    fs.writeFileSync(agent, [
      "const fs = require('node:fs');",
      "const { execSync } = require('node:child_process');",
      'fs.writeFileSync(process.argv[2], "written by an approved process");',
      // Quoted: the interpreter path contains a space on Windows, and an
      // unquoted spawn would fail for a reason that has nothing to do with
      // what this test is demonstrating.
      'execSync(`"${process.execPath}" -e "1"`);',
    ].join('\n'));

    // 1. The gate sees one shell action and allows it.
    const admission = decide({ command: `node ${agent} ${outside}` }, 'Bash', dir);
    assert.equal(admission.decision, 'allow');

    // 2. The process then writes outside the workspace and spawns a child.
    //    Nothing consults the gate for either.
    cp.execFileSync(process.execPath, [agent, outside], { cwd: dir });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'written by an approved process');

    // 3. Asked directly, the gate refuses the same write outright.
    const direct = decide({ file_path: outside }, 'Write', dir);
    assert.equal(direct.decision, 'block');
    assert.equal(direct.reason, 'external_action_path_outside_workspace');

    fs.rmSync(outside, { force: true });
  } finally {
    cleanup();
  }
});

test('one allowed command converts a block into a silent success', () => {
  // Stated as its own case because this is the sentence a reader needs. The
  // guard's verdict is about the command it was shown, not about the effects
  // that command goes on to have.
  const { dir, cleanup } = workspace();
  try {
    const outside = path.join(os.tmpdir(), `huqan-outside-2-${process.pid}.txt`);
    assert.equal(decide({ file_path: outside }, 'Write', dir).decision, 'block');
    assert.equal(decide({ command: `node script.js ${outside}` }, 'Bash', dir).decision, 'allow');
  } finally {
    cleanup();
  }
});

test('the published manifest carries the disclosure, not only the document', () => {
  // docs/external-action-guard.md states this limit and does not ship: of the
  // whole docs/ tree, package.json#files publishes a single seed file. A
  // consumer installs the package, receives coverage-manifest.json, and would
  // otherwise never see the boundary that decides what "protected" means.
  const manifest = buildCoverageManifest();
  assert.match(manifest.establishes, /approved/i);
  assert.match(manifest.establishes, /process/i);

  const files = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).files;
  assert.ok(files.includes('coverage-manifest.json'), 'the manifest must ship');
  assert.ok(!files.includes('docs/external-action-guard.md'),
    'if the guard document starts shipping, this test should be revisited rather than deleted');
});

test('the document still states the limit it is trusted to state', () => {
  // The manifest disclosure and the document must not drift apart. If the
  // sentence is reworded, this fails and whoever reworded it decides whether
  // the manifest needs the same edit.
  const doc = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'external-action-guard.md'), 'utf8');
  assert.match(doc, /başlattığı/);
  assert.match(doc, /hook'tan geçmez/);
});
