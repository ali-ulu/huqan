#!/usr/bin/env node
'use strict';

// The operator's window onto the approval authority (#3860, ADR-016).
//
// The installer puts a Start menu shortcut, writable only by administrators,
// that runs this file elevated, with the protected node.exe, from the
// protected install. An agent running as the interactive user can neither
// read nor drive an elevated window, and it cannot change what the shortcut
// runs. The user-side `huqan-authority` never launches this elevated itself:
// it lives in a user-writable checkout, and a UAC prompt for code an agent can
// edit would hand that agent the administrator's rights.
//
// The session checks the authority's identity against the pin before it shows
// or asks anything, shows each pending approval's bound arguments -- the
// runtime's summary only as untrusted text -- and sends the operator's code
// sealed with the one action it decides.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const fs = require('node:fs');
const readline = require('node:readline');
const { parseAuthorityPin } = require('./authority-pin');
const { createAuthorityClient, AuthorityError } = require('./authority-client');
const { sealDecisionRequest } = require('./sealed-request');

const INSTALLED_PIN = 'C:\\ProgramData\\huqan-authority\\public\\authority.json';
const CODE = /^\d{6}$/;

function describe(approval, print) {
  print('');
  print(`Approval ${approval.approvalId}  (workspace ${approval.workspaceId}, expires ${approval.expiresAt})`);
  print(`Tool: ${approval.tool}`);
  print('Arguments (this is exactly what will run):');
  for (const line of JSON.stringify(approval.arguments, null, 2).split('\n')) print(`  ${line}`);
  print(`Runtime's summary (untrusted text, not bound to the action): ${approval.summary}`);
}

async function decideOne(client, pin, approval, { ask, print }) {
  describe(approval, print);
  const choice = (await ask('Approve (a), reject (r) or skip (s)? ')).trim().toLowerCase();
  if (choice !== 'a' && choice !== 'r') return;
  const reason = (await ask('Reason (optional): ')).trim().slice(0, 512);
  const totp = (await ask('Authenticator code: ')).trim();
  if (!CODE.test(totp)) {
    print('That is not a six-digit code; nothing was decided.');
    return;
  }
  const decision = choice === 'a' ? 'approved' : 'rejected';
  const sealed = sealDecisionRequest({ approvalId: approval.approvalId, actionHash: approval.actionHash, decision, reason, totp },
    pin.sealingKey);
  const answer = await client.decide(approval.approvalId, sealed);
  if (answer.status === 200) {
    print(`${decision} -- recorded as ledger entry ${answer.body.envelope.payload.ledgerSeq}.`);
  } else {
    print(`Not decided: ${answer.body?.code || `HTTP ${answer.status}`}.`);
  }
}

async function runOperatorSession({ pin, ask, print }) {
  const client = createAuthorityClient({ pin });
  const identity = await client.identity();
  if (identity.status !== 200 || identity.body?.keyId !== pin.keyId) {
    throw new AuthorityError('AUTHORITY_IMPERSONATION', 'the service on the pinned port does not answer under the pinned key');
  }
  for (;;) {
    const listed = await client.list();
    const pending = (listed.body?.approvals || []).filter(a => a.status === 'pending' && Date.parse(a.expiresAt) > Date.now());
    if (pending.length === 0) {
      print('Nothing is waiting for a decision.');
      return;
    }
    print('');
    pending.forEach((a, i) => print(`${i + 1}. ${a.approvalId}  ${a.tool}  (workspace ${a.workspaceId})`));
    const pick = (await ask('Number to review, or q to quit: ')).trim().toLowerCase();
    if (pick === 'q' || pick === '') return;
    const chosen = pending[Number(pick) - 1];
    if (!chosen) continue;
    const shown = await client.show(chosen.approvalId);
    if (shown.status !== 200) {
      print(`Could not load ${chosen.approvalId}: ${shown.body?.code}.`);
      continue;
    }
    await decideOne(client, pin, shown.body.approval, { ask, print });
  }
}

async function main() {
  const pinPath = process.argv[2] === '--pin' ? process.argv[3] : INSTALLED_PIN;
  const parsed = parseAuthorityPin(fs.readFileSync(pinPath, 'utf8'));
  if (!parsed.ok) throw new Error(`the authority pin cannot be trusted (${parsed.reason})`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));
  try {
    await runOperatorSession({ pin: parsed.pin, ask, print: line => process.stdout.write(`${line}\n`) });
  } finally {
    await ask('\nPress Enter to close.');
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`\nHUQAN Authority: ${error.message}\nPress Enter to close.\n`);
    process.stdin.once('data', () => process.exit(1));
  });
}

module.exports = { runOperatorSession };
