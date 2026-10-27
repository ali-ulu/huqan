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
  const { canonicalActionHash } = require('../lib/mcp-operator-capability');
  const { buildApprovalDecisionAttestation } = require('../lib/authority/decision-attestation');
  const { buildLearningProposal } = require('../lib/experience/learning-intake');
  const { qualify } = require('../lib/experience/compiler');
  const { buildCoderPromotionReceipt, persistCoderPromotionReceipt } = require('../lib/experience/coder-promotion-receipt');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-promotion-'));
  const root = path.join(fixture, 'repo'), taskFile = path.join(fixture, 'task.json');
  const journalPath = path.join(fixture, 'evidence.db'), pinFile = path.join(fixture, 'pin.json');
  const clockFile = path.join(fixture, 'clock.js');
  let server, store;
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
      if (capability) args.push('--promotion-approval', 'approval', '--promotion-capability', capability);
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
    const proposals = [0, 1].map(parentVersion => buildLearningProposal(store.journal, { runId: 'source',
      workspaceId: 'default', parentVersion, params: { path: 'docs/a.md', oldText: 'before', newText: 'after' } }));
    assert.ok(proposals.every(proposal => proposal.ok));
    const nextProcedure = proposals[1].procedure;
    const qualification = qualify({ procedure: nextProcedure, inputs: ['separate before'], observe: value => value,
      apply: (procedure, value) => ({ sites: value.split(procedure.params.oldText).length - 1,
        after: value.replace(procedure.params.oldText, () => procedure.params.newText) }) });
    assert.equal(qualification.qualified, true);
    const created = createAuthorityState({ dir: path.join(fixture, 'authority') });
    const state = openAuthorityState({ dir: path.join(fixture, 'authority'), operatorId: 'operator' });
    const service = createAuthorityService({ state, ledger: openLedgerStore({ file: path.join(fixture, 'ledger.jsonl') }) });
    const args = { argv: ['--capability', 'public-replace'] };
    const actionHash = canonicalActionHash({ tool: 'terfi', workspaceId: 'default', approvalId: 'approval', arguments: args });
    const consumeProof = 'runtime-held-consume-proof-0123456789abcdef';
    assert.equal(service.register({ approvalId: 'approval', workspaceId: 'default', tool: 'terfi', arguments: args,
      actionHash, consumeProofHash: crypto.createHash('sha256').update(consumeProof).digest('hex'), summary: 'promotion',
      expiresAt: new Date(Date.now() + 3600000).toISOString() }).status, 201);
    const sealed = sealDecisionRequest({ approvalId: 'approval', actionHash, decision: 'approved', reason: 'checked',
      totp: totpAt(created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS)) }, created.sealingPublicKeyPem);
    const decided = service.decide('approval', sealed);
    assert.equal(decided.status, 200);
    assert.equal(service.consume('approval', { actionHash, consumeProof }).status, 200);
    const receipt = buildCoderPromotionReceipt({ approvalId: 'approval', workspaceId: 'default', actionHash,
      capabilityId: 'public-replace', inputArtifactDigests: { candidate: nextProcedure.hash },
      previousProcedure: proposals[0].procedure, nextProcedure,
      sourceRunHashes: [{ runId: 'source', sourceHash: proposals[1].sourceHash }], qualification, outcome: 'promoted' });
    const recorded = service.recordOutcome('approval', { status: 'executed', receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash, consumeProof });
    assert.equal(recorded.status, 200);
    const decisionAttestation = buildApprovalDecisionAttestation({ decisionEnvelope: decided.body.envelope,
      outcomeAttestation: recorded.body.attestation }, receipt, { publicKey: created.signingPublicKeyPem });
    const persisted = persistCoderPromotionReceipt({ journal: store.journal, receipt, decisionAttestation,
      publicKey: created.signingPublicKeyPem });
    assert.equal(persisted.ok, true, persisted.code);
    store.close(); store = null;
    server = createAuthorityServer({ service, signingKey: state.signingKey });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(pinFile, JSON.stringify({ v: 'huqan.authority.pin.v1', port: server.address().port,
      keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem }));
    fs.writeFileSync(taskFile, JSON.stringify({ ...task, test: { command: 'node acceptance.test.js' },
      experience: { riskTier: 'low', candidates: [{
      capabilityId: 'public-replace', sourceRunIds: ['source'], parentVersion: 1,
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }] } }));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const wrong = await run('wrong-capability', 'different');
    assert.notEqual(wrong.code, 0, JSON.stringify(wrong));
    assert.match(JSON.stringify(wrong.report), /promotion_binding_mismatch/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
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
    await new Promise(resolve => server.close(resolve)); server = null;
    const unavailable = await run('authority-down', 'public-replace');
    assert.notEqual(unavailable.code, 0, JSON.stringify(unavailable));
    assert.match(JSON.stringify(unavailable.report), /AUTHORITY_UNAVAILABLE/);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
  } finally {
    store?.close();
    if (server) await new Promise(resolve => server.close(resolve));
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
