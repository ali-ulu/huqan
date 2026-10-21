'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { createCommandPolicyEditor } = require('../lib/command-policy-editor');
const { readAllowedCommands, readDataResidency } = require('../lib/external-action-command-policy');
const { POLICY_TEMPLATES, listPolicyTemplates, getPolicyTemplate } = require('../lib/command-policy-templates');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'huqan-gate-hook.js');

/**
 * The sample action set every template is measured against. It is a fixed
 * table, not a measurement of a real deployment: the same commands are asked
 * of every template, so the decisions below can be read side by side.
 */
const SAMPLE = Object.freeze([
  'git status',
  'git diff',
  'cat package.json',
  'ls -la',
  'npm test',
  'npm run build',
  'npm run lint',
  'node --test',
  'npm run typecheck',
  'npm run test',
  'npm run check',
  'npm ci',
  'npm run deploy',
  'rm -rf build',
  'git push',
  'chmod +x script.sh',
  'gh pr merge',
]);

// The expected decision of every template for every command of the sample
// set. Fixed here so a change in the gate or in a template shows up as a
// failing expectation rather than as a quieter gate.
const EXPECTED = Object.freeze({
  'solo-dev': Object.freeze({
    'git status': 'allow', 'git diff': 'allow', 'cat package.json': 'allow', 'ls -la': 'allow',
    'npm test': 'allow', 'npm run build': 'allow', 'npm run lint': 'allow', 'node --test': 'allow',
    'npm run typecheck': 'review', 'npm run test': 'review', 'npm run check': 'review',
    'npm ci': 'review', 'npm run deploy': 'review', 'rm -rf build': 'review',
    'git push': 'block', 'chmod +x script.sh': 'block', 'gh pr merge': 'block',
  }),
  'team-ci': Object.freeze({
    'git status': 'allow', 'git diff': 'allow', 'cat package.json': 'allow', 'ls -la': 'allow',
    'npm test': 'allow', 'npm run build': 'allow', 'npm run lint': 'allow', 'node --test': 'allow',
    'npm run typecheck': 'allow', 'npm run test': 'allow', 'npm run check': 'allow',
    'npm ci': 'review', 'npm run deploy': 'review', 'rm -rf build': 'review',
    'git push': 'block', 'chmod +x script.sh': 'block', 'gh pr merge': 'block',
  }),
  regulated: Object.freeze({
    'git status': 'allow', 'git diff': 'allow', 'cat package.json': 'allow', 'ls -la': 'allow',
    'npm test': 'allow',
    'npm run build': 'review', 'npm run lint': 'review', 'node --test': 'review',
    'npm run typecheck': 'review', 'npm run test': 'review', 'npm run check': 'review',
    'npm ci': 'review', 'npm run deploy': 'review', 'rm -rf build': 'review',
    'git push': 'block', 'chmod +x script.sh': 'block', 'gh pr merge': 'block',
  }),
  'read-only-agent': Object.freeze({
    'git status': 'allow', 'git diff': 'allow', 'cat package.json': 'allow', 'ls -la': 'allow',
    'npm test': 'review', 'npm run build': 'review', 'npm run lint': 'review', 'node --test': 'review',
    'npm run typecheck': 'review', 'npm run test': 'review', 'npm run check': 'review',
    'npm ci': 'review', 'npm run deploy': 'review', 'rm -rf build': 'review',
    'git push': 'block', 'chmod +x script.sh': 'block', 'gh pr merge': 'block',
  }),
});

function memoryWriter() {
  const receipts = [];
  return { receipts, append(receipt) { receipts.push(receipt); } };
}

/** The decision the real gate gives this command under this allowlist. */
function decisionFor(command, allowedCommands) {
  const result = evaluateExternalAction({
    invocationId: 'call-1', agentName: 'template-tester', sessionId: 'session-1', toolName: 'Bash',
    args: { command }, cwd: ROOT, workspaceRoot: ROOT,
  }, { allowedCommands, requireIdentityCard: false, receiptWriter: memoryWriter() });
  return { decision: result.decision, category: result.envelope.riskCategory };
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-policy-template-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('every template decides the sample action set the way the table says', () => {
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const template = getPolicyTemplate(id);
    assert.ok(template, id);
    for (const command of SAMPLE) {
      const { decision } = decisionFor(command, [...template.allowedCommands]);
      assert.equal(decision, expected[command], `${id}: ${command}`);
    }
  }
});

test('a template only promotes the commands it names, and nothing else', () => {
  // The gate's own basis: a command the classifier already read as read-only
  // or as a write, a deploy or a permission change keeps exactly the decision
  // it has without a template. A template cannot loosen that, and it cannot
  // promote a category the allowlist was never allowed to promote.
  for (const [id, template] of Object.entries(POLICY_TEMPLATES)) {
    for (const command of SAMPLE) {
      const baseline = decisionFor(command, []);
      const applied = decisionFor(command, [...template.allowedCommands]);
      if (baseline.category === 'TOOL_CHAIN_EXECUTION') {
        const named = template.allowedCommands.some(entry => command === entry || command.startsWith(`${entry} `));
        assert.equal(applied.decision, named ? 'allow' : baseline.decision, `${id}: ${command}`);
        continue;
      }
      assert.equal(applied.decision, baseline.decision, `${id}: ${command}`);
      assert.equal(applied.category, baseline.category, `${id}: ${command}`);
    }
  }
});

test('every template entry is a command the gate would otherwise send to a human', () => {
  // The allowlist can only promote a tool chain. An entry that names a write,
  // a deploy or a permission change would read as a fix while changing
  // nothing, so no template may carry one.
  for (const [id, template] of Object.entries(POLICY_TEMPLATES)) {
    for (const entry of template.allowedCommands) {
      const baseline = decisionFor(entry, []);
      assert.equal(baseline.category, 'TOOL_CHAIN_EXECUTION', `${id}: ${entry}`);
      assert.equal(baseline.decision, 'review', `${id}: ${entry}`);
      assert.ok(entry.split(' ').length >= 2, `${id}: ${entry} is a one-word entry`);
      assert.ok(SAMPLE.includes(entry), `${id}: ${entry} is not in the sample action set`);
    }
  }
});

test('the templates are listed, and an unknown id is not a template', () => {
  const listed = listPolicyTemplates().map(entry => entry.id);
  assert.deepEqual(listed, Object.keys(POLICY_TEMPLATES));
  assert.equal(getPolicyTemplate('solo-dev').id, 'solo-dev');
  assert.equal(getPolicyTemplate('nope'), null);
  assert.equal(getPolicyTemplate('solo-dev ').id, 'solo-dev');
});

test('applying a template writes the deployment policy file', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  const editor = createCommandPolicyEditor(target);
  const applied = editor.applyTemplate('solo-dev');
  assert.equal(applied.template, 'solo-dev');
  assert.equal(applied.backup, null);
  assert.deepEqual(readAllowedCommands(target), [...getPolicyTemplate('solo-dev').allowedCommands]);
  assert.deepEqual(readAllowedCommands(target), ['npm test', 'npm run build', 'npm run lint', 'node --test']);
  assert.equal(readDataResidency(target), null);
});

test('applying a template never overwrites an existing policy without approval', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  fs.writeFileSync(target, JSON.stringify({ allowedCommands: ['npm run lint'] }));
  const before = fs.readFileSync(target, 'utf8');
  const editor = createCommandPolicyEditor(target);
  assert.throws(() => editor.applyTemplate('solo-dev'), { code: 'POLICY_EXISTS' });
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(fs.existsSync(`${target}.editor-lock`), false);
});

test('an approved replacement backs the old policy file up first', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  fs.writeFileSync(target, JSON.stringify({ allowedCommands: ['npm run lint'] }));
  const before = fs.readFileSync(target, 'utf8');
  const applied = createCommandPolicyEditor(target).applyTemplate('team-ci', { approved: true });
  assert.ok(applied.backup, 'a backup path is reported');
  assert.equal(fs.readFileSync(applied.backup, 'utf8'), before);
  assert.deepEqual(readAllowedCommands(target), [...getPolicyTemplate('team-ci').allowedCommands]);
});

test('a declared residency is written as the operator stated it', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  const applied = createCommandPolicyEditor(target).applyTemplate('regulated', { residency: ['example.com.tr', ' s3.example.com.tr '] });
  assert.deepEqual(applied.residency, ['example.com.tr', 's3.example.com.tr']);
  assert.deepEqual(readDataResidency(target), { allowedDestinations: ['example.com.tr', 's3.example.com.tr'] });
  assert.equal(applied.requiresResidency, true);
  // The same value as text, and an entry that is not a host name at all.
  const text = createCommandPolicyEditor(path.join(directory, 'text.json')).applyTemplate('regulated', { residency: 'a.example.com, b.example.com' });
  assert.deepEqual(text.residency, ['a.example.com', 'b.example.com']);
  const mixed = createCommandPolicyEditor(path.join(directory, 'mixed.json')).applyTemplate('regulated', { residency: [42, 'c.example.com'] });
  assert.deepEqual(mixed.residency, ['c.example.com']);
  // Without a declaration the gate is told nothing, and the template says so.
  const bare = createCommandPolicyEditor(path.join(directory, 'bare.json')).applyTemplate('regulated');
  assert.deepEqual(bare.residency, []);
  assert.equal(readDataResidency(path.join(directory, 'bare.json')), null);
});

test('an unknown template is refused and writes nothing', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  assert.throws(() => createCommandPolicyEditor(target).applyTemplate('nope'), { code: 'UNKNOWN_TEMPLATE' });
  assert.equal(fs.existsSync(target), false);
});

test('applying a template creates the scope directory it writes into', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'workspaces', 'default', 'external-action-policy.json');
  const applied = createCommandPolicyEditor(target).applyTemplate('read-only-agent');
  assert.equal(applied.template, 'read-only-agent');
  assert.deepEqual(readAllowedCommands(target), []);
  assert.equal(fs.existsSync(path.join(directory, 'workspaces', 'default')), true);
});

test('the CLI applies a template, refuses to replace a file, and backs it up on request', t => {
  const directory = scratch(t);
  const target = path.join(directory, 'external-action-policy.json');
  const listed = spawnSync(process.execPath, [HOOK, 'policy', 'list'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).templates.map(entry => entry.id), Object.keys(POLICY_TEMPLATES));

  const applied = spawnSync(process.execPath, [HOOK, 'policy', 'apply', 'solo-dev', '--policy', target], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).template, 'solo-dev');
  assert.deepEqual(readAllowedCommands(target), ['npm test', 'npm run build', 'npm run lint', 'node --test']);

  const refused = spawnSync(process.execPath, [HOOK, 'policy', 'apply', 'team-ci', '--policy', target], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.error, 'POLICY_EXISTS');
  assert.deepEqual(readAllowedCommands(target), ['npm test', 'npm run build', 'npm run lint', 'node --test']);

  const forced = spawnSync(process.execPath, [HOOK, 'policy', 'apply', 'team-ci', '--policy', target, '--force'], { encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(fs.existsSync(JSON.parse(forced.stdout).backup));
  assert.deepEqual(readAllowedCommands(target), [...getPolicyTemplate('team-ci').allowedCommands]);
});

test('the documented review ratio of every template is the measured one', () => {
  const documentation = fs.readFileSync(path.join(ROOT, 'docs', 'policy-templates.md'), 'utf8');
  for (const [id, template] of Object.entries(POLICY_TEMPLATES)) {
    const section = documentation.split(`## ${id}`)[1] || '';
    const measured = SAMPLE.filter(command => decisionFor(command, [...template.allowedCommands]).decision === 'review').length;
    const stated = section.match(/Review ratio \(sample action set\): (\d+)\/(\d+)/);
    assert.ok(stated, `${id} has no documented review ratio`);
    assert.equal(Number(stated[1]), measured, `${id} review ratio`);
    assert.equal(Number(stated[2]), SAMPLE.length, `${id} sample size`);
  }
});
