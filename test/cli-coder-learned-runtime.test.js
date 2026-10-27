'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openCoderJournal } = require('../lib/coder/journal-store');

test('public CLI revalidates a real promotion receipt in each child and refuses unavailable authority', async () => {
  const crypto = require('node:crypto');
  const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
  const { openLedgerStore } = require('../lib/authority/ledger-store');
  const { createAuthorityService } = require('../lib/authority/authority-service');
  const { createAuthorityServer } = require('../lib/authority/http-server');
  const { keyIdFor } = require('../lib/authority/decision-envelope');
  const { sealDecisionRequest } = require('../lib/authority/sealed-request');
  const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
  const { createAuthorityClient } = require('../lib/authority/authority-client');
  const { parseAuthorityPin } = require('../lib/authority/authority-pin');
  const { request, apply } = require('../bin/huqan-authority');
  const { buildLearningProposal } = require('../lib/experience/learning-intake');
  const { qualify } = require('../lib/experience/compiler');
  const { readCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-promotion-'));
  const root = path.join(fixture, 'repo'), taskFile = path.join(fixture, 'task.json');
  const journalPath = path.join(fixture, 'evidence.db'), pinFile = path.join(fixture, 'pin.json');
  const clockFile = path.join(fixture, 'clock.js');
  const savedEnv = { HUQAN_MEMORY_PATH: process.env.HUQAN_MEMORY_PATH, HUQAN_DB_PATH: process.env.HUQAN_DB_PATH };
  process.env.HUQAN_MEMORY_PATH = path.join(fixture, 'authority-memory.json');
  process.env.HUQAN_DB_PATH = path.join(fixture, 'authority-memory.db');
  let server, store, approvalId;
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(clockFile, `const budget = require(${JSON.stringify(path.join(__dirname, '../lib/experience/budgeted-journal'))});
const wrap = budget.budgetExperienceJournal; let tick = 0;
budget.budgetExperienceJournal = (journal, options) => wrap(journal, { ...options, now: () => (tick += 0.1) });
`);
    for (const [file, content] of [['a.md', 'before'], ['drift.md', 'absent'], ['ambiguous.md', 'before before']])
      fs.writeFileSync(path.join(root, 'docs', file), content);
    fs.writeFileSync(path.join(root, 'acceptance.test.js'),
      "require('node:assert/strict').equal(require('node:fs').readFileSync('docs/a.md', 'utf8'), 'after');\n");
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    git(['init', '-q', '-b', 'feat/promotion-cli']);
    git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'commit.gpgsign', 'false']); git(['add', 'docs', 'acceptance.test.js']); git(['commit', '-qm', 'fixture']);
    const task = { id: 'promotion-cli', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    fs.writeFileSync(taskFile, JSON.stringify(task));
    const run = async (id, capability) => {
      const args = ['--require', clockFile, path.join(__dirname, '..', 'cli.js'), 'coder', taskFile,
        '--root', root, '--journal', journalPath, '--run-id', id, '--json'];
      if (capability) args.push('--promotion-approval', approvalId, '--promotion-capability', capability);
      try {
        const result = await promisify(execFile)(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, HUQAN_AUTHORITY_PIN_PATH: pinFile, HUQAN_STATE_ROOT: path.join(fixture, 'runtime'),
            HUQAN_MEMORY_PATH: path.join(fixture, 'memory.json'), HUQAN_DB_PATH: path.join(fixture, 'memory.db') } });
        return { code: 0, report: JSON.parse(result.stdout) };
      } catch (error) { return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }; }
    };
    const source = await run('source');
    assert.equal(source.report?.data?.outcome, 'applied', JSON.stringify(source));
    store = openCoderJournal(journalPath);
    const proposals = [0, 1, 2].map(parentVersion => buildLearningProposal(store.journal, { runId: 'source',
      workspaceId: 'default', parentVersion, params: { path: 'docs/a.md', oldText: 'before', newText: 'after' } }));
    assert.ok(proposals.every(proposal => proposal.ok));
    const nextProcedure = proposals[1].procedure;
    const artifacts = proposals.map(proposal => {
      const qualification = qualify({ procedure: proposal.procedure, inputs: ['separate before'], observe: value => value,
        apply: (procedure, value) => ({ sites: value.split(procedure.params.oldText).length - 1,
          after: value.replace(procedure.params.oldText, () => procedure.params.newText) }) });
      assert.equal(qualification.qualified, true);
      return { procedure: proposal.procedure, qualification,
        sourceRunHashes: [{ runId: 'source', sourceHash: proposal.sourceHash }] };
    });
    store.close(); store = null;
    const created = createAuthorityState({ dir: path.join(fixture, 'authority') });
    const state = openAuthorityState({ dir: path.join(fixture, 'authority'), operatorId: 'operator' });
    const service = createAuthorityService({ state, ledger: openLedgerStore({ file: path.join(fixture, 'ledger.jsonl') }) });
    server = createAuthorityServer({ service, signingKey: state.signingKey });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(pinFile, JSON.stringify({ v: 'huqan.authority.pin.v1', port: server.address().port,
      keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem }));
    const pin = parseAuthorityPin(fs.readFileSync(pinFile, 'utf8')).pin;
    const consumeKey = crypto.randomBytes(32);
    const deps = { resolveMode: () => ({ mode: 'service', boundary: 'os-service', pin }), loadConsumeKey: () => consumeKey };
    const startAt = Date.now() - 3600000;
    // Synthetic costs exercise promotion gates; both versions perform the same replacement.
    const runs = (prefix, cost) => Array.from({ length: 12 }, (_, i) => ({ occurredAt: startAt + i * 60000,
      learningEligibility: 'positive_procedure', executionCost: cost, verificationCost: 1, canaryOverheadCost: 0,
      eventId: `${prefix}-e${i}`, runId: `${prefix}-r${i}` }));
    const contents = { aday: artifacts[1], bagli: artifacts[0],
      deneme: { candidateRuns: runs('candidate', 5), baselineWindowRuns: runs('baseline', 10), startAt },
      gozlem: { currentEvents: runs('observed', 5) } };
    const digests = {}, argv = [];
    for (const [name, value] of Object.entries(contents)) {
      const file = path.join(fixture, `${name}.json`), text = JSON.stringify(value);
      fs.writeFileSync(file, text); digests[name] = crypto.createHash('sha256').update(text).digest('hex');
      argv.push(`--${name}`, file);
    }
    argv.push('--capability', 'public-replace', '--onaylayan', os.userInfo().username,
      '--karar', 'approved', '--journal', journalPath);
    const registered = await request('terfi', { argsJson: JSON.stringify({ argv, digests }) }, deps);
    assert.equal(registered.code, 0, JSON.stringify(registered.report));
    approvalId = registered.report.approvalId;
    const client = createAuthorityClient({ pin });
    const shown = await client.show(approvalId);
    const sealed = sealDecisionRequest({ approvalId, actionHash: shown.body.approval.actionHash,
      decision: 'approved', reason: 'checked',
      totp: totpAt(created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)) }, created.sealingPublicKeyPem);
    assert.equal((await client.decide(approvalId, sealed)).status, 200);
    const applied = await apply(approvalId, {}, deps);
    assert.equal(applied.code, 0, JSON.stringify(applied.report));
    assert.equal(applied.report.executed, true);
    assert.equal(applied.report.promotionReceiptStored, true);
    store = openCoderJournal(journalPath);
    const stored = readCoderPromotionReceipt({ journal: store.journal, approvalId, workspaceId: 'default', publicKey: pin.signingKey });
    assert.equal(stored.ok, true, stored.code);
    assert.equal(stored.receipt.nextProcedure.hash, nextProcedure.hash);
    store.close(); store = null;
    fs.writeFileSync(taskFile, JSON.stringify({ ...task, test: { command: 'node acceptance.test.js' },
      experience: { riskTier: 'low', candidates: [{
      capabilityId: 'public-replace', sourceRunIds: ['source'], parentVersion: 1,
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }] } }));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const wrong = await run('wrong-capability', 'different');
    assert.notEqual(wrong.code, 0, JSON.stringify(wrong));
    assert.match(JSON.stringify(wrong.report), /promotion_binding_mismatch/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    const acceptedTask = fs.readFileSync(taskFile, 'utf8');
    const mismatchedTask = JSON.parse(acceptedTask);
    mismatchedTask.experience.candidates[0].parentVersion = 2;
    fs.writeFileSync(taskFile, JSON.stringify(mismatchedTask));
    const mismatched = await run('mismatched-final-procedure', 'public-replace');
    assert.notEqual(mismatched.code, 0, JSON.stringify(mismatched));
    assert.match(JSON.stringify(mismatched.report), /PROMOTION_ACCEPTANCE_BINDING_MISMATCH/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    fs.writeFileSync(taskFile, acceptedTask);
    for (const id of ['accepted-first-child', 'accepted-second-child']) {
      const accepted = await run(id, 'public-replace');
      assert.equal(accepted.report?.status, 'completed', JSON.stringify(accepted));
      assert.equal(accepted.report.data.attempts[0].test.ran, true);
      assert.equal(accepted.report.data.attempts[0].test.ok, true);
      assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
      store = openCoderJournal(journalPath);
      const decision = store.journal.read(`${id}:c1`).find(event => event.type === 'routing_decided');
      assert.equal(decision.payload.chosenCapabilityId, 'public-replace');
      assert.equal(decision.payload.boundProcedureVersion, nextProcedure.hash);
      store.close(); store = null;
      fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    }
    const promotedApprovalId = approvalId;
    const rollbackContents = { aday: artifacts[2], bagli: artifacts[1],
      deneme: { candidateRuns: runs('rollback-candidate', 5), baselineWindowRuns: runs('rollback-baseline', 10), startAt },
      gozlem: { currentEvents: runs('rollback-observed', 50) } };
    const rollbackDigests = {}, rollbackArgv = [];
    for (const [name, value] of Object.entries(rollbackContents)) {
      const file = path.join(fixture, `rollback-${name}.json`), text = JSON.stringify(value);
      fs.writeFileSync(file, text); rollbackDigests[name] = crypto.createHash('sha256').update(text).digest('hex');
      rollbackArgv.push(`--${name}`, file);
    }
    rollbackArgv.push('--capability', 'public-replace', '--onaylayan', os.userInfo().username,
      '--karar', 'approved', '--geri-alma', 'approved', '--journal', journalPath);
    const rollbackRegistered = await request('terfi', { argsJson: JSON.stringify({ argv: rollbackArgv, digests: rollbackDigests }) }, deps);
    assert.equal(rollbackRegistered.code, 0, JSON.stringify(rollbackRegistered.report));
    const rollbackApprovalId = rollbackRegistered.report.approvalId;
    const rollbackShown = await client.show(rollbackApprovalId);
    // verifyTotp's default window=1 accepts the next counter; the consumed counter cannot be replayed.
    const rollbackSealed = sealDecisionRequest({ approvalId: rollbackApprovalId,
      actionHash: rollbackShown.body.approval.actionHash, decision: 'approved', reason: 'checked rollback',
      totp: totpAt(created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + 1) }, created.sealingPublicKeyPem);
    const rollbackDecision = await client.decide(rollbackApprovalId, rollbackSealed);
    assert.equal(rollbackDecision.status, 200, JSON.stringify(rollbackDecision.body));
    const rolled = await apply(rollbackApprovalId, {}, deps);
    assert.equal(rolled.code, 0, JSON.stringify(rolled.report));
    assert.equal(rolled.report.executed, true);
    assert.equal(rolled.report.promotionReceiptStored, true);
    store = openCoderJournal(journalPath);
    const rollbackReceipt = readCoderPromotionReceipt({ journal: store.journal, approvalId: rollbackApprovalId,
      workspaceId: 'default', publicKey: pin.signingKey });
    assert.equal(rollbackReceipt.ok, true, rollbackReceipt.code);
    assert.equal(rollbackReceipt.receipt.outcome, 'rolled_back');
    assert.equal(rollbackReceipt.receipt.previousProcedure.hash, proposals[2].procedure.hash);
    assert.equal(rollbackReceipt.receipt.nextProcedure.hash, nextProcedure.hash);
    store.close(); store = null;
    approvalId = promotedApprovalId;
    const superseded = await run('superseded-after-rollback', 'public-replace');
    assert.notEqual(superseded.code, 0, JSON.stringify(superseded));
    assert.match(JSON.stringify(superseded.report), /PROMOTION_ACCEPTANCE_SUPERSEDED/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    approvalId = rollbackApprovalId;
    const rollbackAccepted = await run('accepted-rollback-child', 'public-replace');
    assert.equal(rollbackAccepted.report?.status, 'completed', JSON.stringify(rollbackAccepted));
    assert.equal(rollbackAccepted.report.data.attempts[0].test.ran, true);
    assert.equal(rollbackAccepted.report.data.attempts[0].test.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
    store = openCoderJournal(journalPath);
    const rollbackRoute = store.journal.read('accepted-rollback-child:c1').find(event => event.type === 'routing_decided');
    assert.equal(rollbackRoute.payload.chosenCapabilityId, 'public-replace');
    assert.equal(rollbackRoute.payload.boundProcedureVersion, nextProcedure.hash);
    store.close(); store = null;
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    await new Promise(resolve => server.close(resolve)); server = null;
    const unavailable = await run('authority-down', 'public-replace');
    assert.notEqual(unavailable.code, 0, JSON.stringify(unavailable));
    assert.match(JSON.stringify(unavailable.report), /AUTHORITY_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
  } finally {
    store?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('public coder CLI reopens evidence and dispatches a learned procedure to a real file', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-public-learned-'));
  const root = path.join(fixture, 'workspace');
  const taskFile = path.join(fixture, 'task.json');
  const dbFile = path.join(fixture, 'evidence.db');
  const clockFile = path.join(fixture, 'clock.js');
  let store;
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    // Routing acceptance controls the budget clock; real commit timing and
    // budget refusal have their own production-budget tests. No I/O is mocked.
    fs.writeFileSync(clockFile, `const budget = require(${JSON.stringify(path.join(__dirname, '../lib/experience/budgeted-journal'))});
const wrap = budget.budgetExperienceJournal; let tick = 0;
budget.budgetExperienceJournal = (journal, options) => wrap(journal, { ...options, now: () => (tick += 0.1) });
`);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
    fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-b', 'feat/learned-cli-fixture', '-q']);
    git(['config', 'user.name', 'fixture']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['add', 'docs/a.md', 'docs/drift.md', 'docs/ambiguous.md']);
    git(['commit', '-qm', 'fixture']);
    const task = { id: 'public-learned', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    const run = id => JSON.parse(execFileSync(process.execPath, ['--require', clockFile, path.join(__dirname, '..', 'cli.js'),
      'coder', taskFile, '--root', root, '--journal', dbFile, '--run-id', id, '--json'],
    { cwd: root, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(fixture, 'state'),
        HUQAN_MEMORY_PATH: path.join(fixture, 'memory.json'), HUQAN_DB_PATH: path.join(fixture, 'memory.db') } }));
    fs.writeFileSync(taskFile, JSON.stringify(task));
    const source = run('public-source');
    assert.equal(source.data.outcome, 'applied', JSON.stringify({ reason: source.data.reason, detail: source.data.detail,
      status: git(['status', '--short']) }));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    fs.writeFileSync(taskFile, JSON.stringify({ ...task, experience: { riskTier: 'low', candidates: [{
      capabilityId: 'public-replace', sourceRunIds: ['public-source'],
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'],
    }] } }));
    const routed = run('public-routed');
    assert.equal(routed.data.outcome, 'applied', JSON.stringify({ reason: routed.data.reason, detail: routed.data.detail }));
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
    store = openCoderJournal(dbFile);
    const decision = store.journal.read('public-routed').find(event => event.type === 'routing_decided');
    assert.equal(decision.payload.chosenCapabilityId, 'public-replace');
    assert.equal(store.journal.manifest('public-routed').learningEligibility, 'positive_procedure');
  } finally {
    store?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
