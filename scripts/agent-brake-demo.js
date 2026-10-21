#!/usr/bin/env node
'use strict';

// `npm run demo:agent-brake` -- the shortest honest version of the agent brake
// (#4104).
//
// One command, no network, no service, nothing of yours touched: the demo makes
// a temporary workspace, lets an agent try to delete a file in it, and shows the
// four things a reviewer came to see.
//
//   1. the gate stops the delete and the file is still there
//   2. the operator decides, with a TOTP code, and a wrong code is refused
//   3. only an authorized decision lets the delete run
//   4. the Trust Receipt that records it verifies with HUQAN's own verifier
//
// The gate, the identity card, the receipt chain and the verifier are the
// production modules. Only the approval authority is stood in for -- there is
// none installed on this machine -- and the stand-in says so on every line it
// prints, because the runtime's decision guard refuses a demo decision outright
// (step 5).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKSPACE_ID = 'demo';
const APPROVAL_ID = 'demo-approval-1';
const FILE_NAME = 'notes.txt';

function prepareState({ root } = {}) {
  const base = root ? fs.mkdtempSync(path.join(root, 'huqan-agent-brake-')) : fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-brake-'));
  const workspace = path.join(base, 'workspace');
  const state = path.join(base, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const notes = path.join(workspace, FILE_NAME);
  fs.writeFileSync(notes, 'demo notes: the file the agent wants to delete\n');

  // A throwaway issuer key, so the receipt is signed and the signature can be
  // checked against a public key this run never touches again.
  const issuer = crypto.generateKeyPairSync('ed25519');
  const keyPath = path.join(state, 'issuer-key.pem');
  fs.writeFileSync(keyPath, issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  process.env.HUQAN_ISSUER_SEAL_KEY = keyPath;
  process.env.HUQAN_STATE_ROOT = state;
  process.env.HUQAN_DB_PATH = path.join(state, 'graph.db');
  process.env.HUQAN_MEMORY_PATH = path.join(state, 'memory.db');

  return { base, workspace, state, notes, issuerPublicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** The gate's answer, as the host reads it: an allow runs, a review asks, a block refuses. */
function hostAnswer(evaluated) {
  const permission = evaluated.projection?.output?.hookSpecificOutput?.permissionDecision
    || evaluated.projection?.permissionDecision || 'unknown';
  return { permission, canExecute: evaluated.result.canExecute === true };
}

function describeAttempt(evaluated) {
  const identity = evaluated.result.envelope?.identity || {};
  return {
    decision: evaluated.result.decision,
    reason: evaluated.result.reason,
    hookAnswer: hostAnswer(evaluated).permission,
    canExecute: hostAnswer(evaluated).canExecute,
    identityRef: identity.identityRef || identity.ref || '',
    identityHash: identity.identityHash || identity.hash || '',
    receiptId: evaluated.result.receipt?.receiptId || '',
    receiptPersisted: evaluated.result.receiptPersisted === true,
  };
}

/**
 * The part of the demonstration that matters, importable so a test can assert
 * on it: every step returns what actually happened rather than what should have.
 *
 * @param {{operatorDecision?: 'approved'|'rejected', log?: Function, now?: Function, root?: string}} options
 */
function runDemo({ operatorDecision = 'approved', log = () => {}, now = () => Date.now(), root } = {}) {
  if (!['approved', 'rejected'].includes(operatorDecision)) throw new TypeError('operatorDecision must be approved or rejected');

  const prepared = prepareState({ root });
  const { workspace, notes, issuerPublicKeyPem } = prepared;

  // Required after the state paths are set: the kernel factory reads them.
  const { createKernel } = require('../lib/kernel-factory');
  const { evaluateHookInvocation, EXTERNAL_ADAPTER_PROFILES } = require('../lib/external-action-adapter');
  const { createJsonlExternalActionReceiptWriter } = require('../lib/external-action-receipt');
  const { buildIdentityCard } = require('../lib/external-action-identity-issue');
  const { generateIdentityCardKeyPair, signAgentIdentityCard } = require('../lib/external-action-identity-signing');
  const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
  const { readReceiptById } = require('../lib/receipt/receipt-read-index');
  const { canonicalActionHash } = require('../lib/mcp-operator-capability');
  const { createDemoAuthority, verifyDemoDecision, DEMO_AUTHORITY_LABEL } = require('../lib/demo-authority');
  const { requireAuthorityDecision } = require('../lib/authority/decision-guard');
  const { resolveApprovalAuthorityMode } = require('../lib/authority/authority-mode');

  const kernel = createKernel({ loadPlugins: false });
  const graph = kernel.graph;
  const receiptWriter = createJsonlExternalActionReceiptWriter({ path: path.join(prepared.state, 'external-action-receipts.jsonl') });

  const identityKeys = generateIdentityCardKeyPair();
  const card = buildIdentityCard({
    agentId: 'demo-agent',
    agentName: EXTERNAL_ADAPTER_PROFILES.CLAUDE_CODE,
    agentVersion: '0.0.0',
    ownerActorId: 'operator:demo',
    workspaceId: WORKSPACE_ID,
    capabilities: ['shell', 'file_write'],
  }).card;
  const cardSignature = signAgentIdentityCard(card, identityKeys.privateKeyPem);
  const command = `rm ${FILE_NAME}`;
  const guardOptions = {
    receiptWriter,
    workspaceRoot: workspace,
    workspaceId: WORKSPACE_ID,
    identityCard: card,
    identityCardSignature: cardSignature,
    trustedPublicKeys: [identityKeys.publicKeyPem],
  };
  const attempt = (toolUseId) => evaluateHookInvocation(EXTERNAL_ADAPTER_PROFILES.CLAUDE_CODE, {
    tool_use_id: toolUseId,
    session_id: 'demo-session',
    turn_id: 'demo-turn',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: workspace,
  }, guardOptions);

  // --- 1. the agent tries ---------------------------------------------------
  log('');
  log('1. The agent tries to delete a workspace file');
  log(`   tool call   Bash: ${command}`);
  const first = attempt('demo-agent-brake-1');
  const firstRun = describeAttempt(first);
  log(`   identity    ${firstRun.identityRef || 'unattested'} (signed card, verified by the gate)`);
  log(`   gate        ${firstRun.decision}   ${firstRun.reason}`);
  log(`   hook answer ${firstRun.hookAnswer}   the host stops and asks the operator`);
  // The host runs the tool call only when the gate allows it. It answers
  // `review`, so the delete is not run here even though the agent asked.
  const filePresentAfterBlock = fs.existsSync(notes);
  log(`   executed    no   ${FILE_NAME} is still there: ${filePresentAfterBlock ? 'yes' : 'NO'}`);
  log(`   receipt     ${firstRun.receiptId} (admission receipt, persisted: ${firstRun.receiptPersisted})`);

  // --- 2. the operator decides ---------------------------------------------
  const authority = createDemoAuthority({ now });
  const actionHash = canonicalActionHash({ tool: 'Bash', workspaceId: WORKSPACE_ID, approvalId: APPROVAL_ID,
    arguments: { command } });
  const decide = (code, decision) => authority.decide({ approvalId: APPROVAL_ID, workspaceId: WORKSPACE_ID, tool: 'Bash',
    actionHash, decision, code, at: now() });

  log('');
  log('2. The operator decides');
  log(`   authority   ${DEMO_AUTHORITY_LABEL}`);
  const installed = resolveApprovalAuthorityMode();
  if (installed.mode === 'service') {
    log(`   installed   an approval authority is pinned at ${installed.pinPath}; the real decision is`);
    log('               `huqan-authority decide <approvalId>`, which holds the key and the TOTP secret.');
    log('               This demo does not mint a decision on its behalf (step 5 shows why it cannot).');
  }
  const wrongCode = String((Number(authority.codeAt(now())) + 1) % 1000000).padStart(6, '0');
  const wrong = decide(wrongCode, operatorDecision);
  log(`   wrong code  ${wrongCode} -> refused (${wrong.code})`);
  const code = authority.codeAt(now());
  log(`   code        ${code}   (the demo prints the phone screen; the otpauth URI below is a real one)`);
  log(`   otpauth     ${authority.otpauthUri}`);
  const decided = decide(code, operatorDecision);
  if (!decided.ok) {
    log(`   decision    refused (${decided.code})`);
    graph.close?.();
    return { prepared, authority: 'demo', failure: decided.code, checks: { decisionAccepted: false } };
  }
  log(`   decision    ${decided.envelope.payload.decision}`);

  // The demo holds its own decisions to the same binding the runtime would: the
  // approval, workspace, tool and action hash must be the ones being executed.
  const authorization = verifyDemoDecision(decided.envelope, { publicKey: authority.publicKey,
    expected: { approvalId: APPROVAL_ID, workspaceId: WORKSPACE_ID, tool: 'Bash', actionHash,
      decision: operatorDecision }, now: now() });
  log(`   authorized  ${authorization.ok ? 'yes' : `no (${authorization.code})`}`);

  // --- 3. the delete, and the receipt that records it ----------------------
  log('');
  log('3. Only an authorized decision lets the delete run');
  const second = attempt('demo-agent-brake-2');
  const secondRun = describeAttempt(second);
  log(`   gate        ${secondRun.decision}   ${secondRun.reason}   (a delete never becomes an automatic allow)`);
  const ledger = createTrustEvidenceLedger({ graph });
  const operationId = `agent-brake-demo:${APPROVAL_ID}`;
  const appended = ledger.append({
    operationId,
    event: {
      workspaceId: WORKSPACE_ID,
      decision: secondRun.decision,
      reason: secondRun.reason,
      actionFingerprint: actionHash,
      identityRef: secondRun.identityRef,
      identityHash: secondRun.identityHash,
      approvalRef: APPROVAL_ID,
      executionOutcome: operatorDecision === 'approved' && authorization.ok ? 'executed' : 'not_executed',
      createdAt: new Date(now()).toISOString(),
      metadata: { demo: true, authority: 'demo', operatorDecision, action: command },
    },
    // The effect and the receipt share one mutation: the delete happens inside
    // the record that claims it, or it does not happen.
    mutate: () => {
      if (!(operatorDecision === 'approved' && authorization.ok)) return { executed: false };
      fs.rmSync(notes, { force: true });
      return { executed: true };
    },
  });
  const executed = appended.result?.executed === true;
  log(`   executed    ${executed ? 'yes' : 'no'}   ${FILE_NAME} is still there: ${fs.existsSync(notes) ? 'yes' : 'no'}`);

  // --- 4. the receipt verifies --------------------------------------------
  const receiptId = appended.receipt.canonicalPayload.receiptId;
  const read = readReceiptById(graph, receiptId, { workspaceId: WORKSPACE_ID });
  const seal = graph.verifyMutationReceiptSealByOperation(operationId, { publicKeyPem: issuerPublicKeyPem });
  log('');
  log('4. The Trust Receipt');
  log(`   receipt     ${receiptId}`);
  log(`   hash        ${appended.receipt.receiptHash}`);
  log(`   chain       ${read.ok ? `intact from genesis to the tip (${read.status})` : `INVALID (${read.status})`}`);
  log(`   seal        ${seal.ok ? `signed, signature valid (key ${seal.keyId})` : `unsigned (${seal.reason})`}`);
  log('   verifier    the same code path `huqan receipt verify` runs (readReceiptById)');

  // --- 5. why this demo cannot authorize production -----------------------
  const runtimeRefusal = requireAuthorityDecision({
    mode: { mode: 'service', boundary: 'os-service', pin: { signingKey: authority.publicKey } },
    existing: { tool: 'Bash' },
    approvalId: APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    decision: 'approved',
    storedArgs: { command },
    envelope: decided.envelope,
    now: now(),
  });
  const sameUserRefusal = requireAuthorityDecision({
    mode: { mode: 'legacy', boundary: 'same-user' },
    existing: { tool: 'Bash' },
    approvalId: APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    decision: 'approved',
    storedArgs: { command },
    envelope: decided.envelope,
    now: now(),
  });
  log('');
  log('5. Why the demo cannot authorize production');
  log(`   runtime guard   ${runtimeRefusal.ok ? 'ACCEPTED (this is a bug)' : `${runtimeRefusal.code}`}`);
  log(`   same-user guard ${sameUserRefusal.ok ? 'ACCEPTED (this is a bug)' : `${sameUserRefusal.code}`}`);
  log('   A demo decision is signed by the process being demonstrated, so it proves nothing');
  log('   about the operator. Install an approval authority and decide there.');

  graph.close?.();
  kernel.memory?.close?.();

  return {
    prepared,
    workspaceRoot: workspace,
    notesPath: notes,
    authority: 'demo',
    firstAttempt: firstRun,
    operatorDecision,
    wrongCodeRefusal: wrong.code,
    authorization,
    executed,
    receipt: {
      receiptId,
      receiptHash: appended.receipt.receiptHash,
      chainValid: read.ok === true,
      chainStatus: read.status,
      sealValid: seal.ok === true,
      sealReason: seal.reason || '',
    },
    refusals: { runtimeGuard: runtimeRefusal, sameUserGuard: sameUserRefusal },
    checks: {
      blockedWithoutDecision: firstRun.canExecute === false && filePresentAfterBlock,
      wrongCodeRefused: wrong.ok === false && wrong.code === 'TOTP_INVALID',
      decisionAccepted: true,
      executedOnlyWhenApproved: executed === (operatorDecision === 'approved'),
      receiptVerified: read.ok === true && seal.ok === true,
      demoAuthorityRefused: runtimeRefusal.ok === false && runtimeRefusal.code === 'DEMO_AUTHORITY_REFUSED',
    },
  };
}

function parseArgs(argv) {
  const options = { operatorDecision: 'approved', record: '' };
  for (const arg of argv) {
    if (arg === '--reject') options.operatorDecision = 'rejected';
    else if (arg === '--approve') options.operatorDecision = 'approved';
    else if (arg.startsWith('--record=')) options.record = arg.slice('--record='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

// An asciicast v2 of this run, written by the run itself: the recording is the
// command it documents, so it can be regenerated rather than trusted.
function recorder(target) {
  const lines = [JSON.stringify({ version: 2, width: 100, height: 34, title: 'HUQAN agent brake demo',
    env: { SHELL: '/bin/sh', TERM: 'xterm-256color' } })];
  const started = Date.now();
  const log = (line) => {
    process.stdout.write(`${line}\n`);
    lines.push(JSON.stringify([Number(((Date.now() - started) / 1000).toFixed(3)), 'o', `${line}\r\n`]));
  };
  return { log, close: () => fs.writeFileSync(target, `${lines.join('\n')}\n`) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run demo:agent-brake [-- --reject] [--record=<file.cast>]\n');
    return;
  }
  const sink = options.record ? recorder(options.record) : { log: (line) => process.stdout.write(`${line}\n`), close() {} };
  try {
    const result = runDemo({ operatorDecision: options.operatorDecision, log: sink.log });
    const failed = Object.entries(result.checks || {}).filter(([, ok]) => ok !== true).map(([name]) => name);
    sink.log('');
    sink.log(failed.length
      ? `demo FAILED: ${failed.join(', ')}`
      : (options.operatorDecision === 'approved'
        ? 'demo OK: blocked, decided, executed once, receipt verified'
        : 'demo OK: blocked, rejected, nothing executed, receipt verified'));
    sink.log(`workspace left at ${result.workspaceRoot}`);
  } finally {
    sink.close();
  }
}

if (require.main === module) main();

module.exports = { runDemo, describeAttempt, prepareState };
