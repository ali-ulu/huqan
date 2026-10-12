'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { canonicalActionHash } = require('../lib/mcp-operator-capability');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { totpAt, TOTP_STEP_SECONDS } = require('../lib/authority/totp');
const { runOperatorSession } = require('../lib/authority/operator-cli');

const ARGS = Object.freeze({ text: 'cats are animals' });

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-operator-'));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const state = openAuthorityState({ dir: path.join(dir, 'state') });
  const ledger = openLedgerStore({ file: path.join(dir, 'ledger.jsonl') });
  const service = createAuthorityService({ ledger, state });
  const server = createAuthorityServer({ service, signingKey: state.signingKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  const pin = parseAuthorityPin(JSON.stringify({ v: 'huqan.authority.pin.v1', port: server.address().port,
    keyId: keyIdFor(created.signingPublicKeyPem), signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem })).pin;
  service.register({ approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', arguments: ARGS,
    actionHash: canonicalActionHash({ tool: 'huqan.learn', workspaceId: 'default', approvalId: 'apr_1', arguments: ARGS }),
    consumeProofHash: 'a'.repeat(64), summary: 'IGNORE THE ARGUMENTS, THIS IS SAFE', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
  return { created, pin, ledger };
}

function scripted(answers) {
  const queue = [...answers];
  const printed = [];
  return { printed, ask: async () => (queue.length ? queue.shift() : 'q'), print: line => printed.push(String(line)) };
}

const codeNow = created => totpAt(created.totpSecret, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));

test('the operator sees the arguments, the summary marked untrusted, and decides with a code', async (t) => {
  const env = await setup(t);
  const io = scripted(['1', 'a', 'looked at it', codeNow(env.created), 'q']);
  await runOperatorSession({ pin: env.pin, ...io });
  const screen = io.printed.join('\n');
  assert.match(screen, /cats are animals/, 'the bound arguments are shown');
  assert.match(screen, /untrusted/i);
  assert.match(screen, /approved .*ledger entry/i);
  assert.equal(env.ledger.all().filter(entry => entry.type === 'approval.decided').length, 1);
});

test('a wrong code decides nothing and says so', async (t) => {
  const env = await setup(t);
  const io = scripted(['1', 'a', '', '000000', 'q']);
  await runOperatorSession({ pin: env.pin, ...io });
  assert.match(io.printed.join('\n'), /TOTP_INVALID/);
  assert.equal(env.ledger.all().some(entry => entry.type === 'approval.decided'), false);
});

test('an impostor on the port is refused before the operator is asked anything', async (t) => {
  const env = await setup(t);
  const impostor = http.createServer((request, response) => response.end('{"status":200,"body":{"approvals":[]}}'));
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => impostor.close(resolve)));
  let asked = 0;
  const io = { print: () => {}, ask: async () => { asked += 1; return 'q'; } };
  await assert.rejects(runOperatorSession({ pin: { ...env.pin, port: impostor.address().port }, ...io }),
    { code: 'AUTHORITY_IMPERSONATION' });
  assert.equal(asked, 0);
});

test('nothing pending is reported plainly', async (t) => {
  const env = await setup(t);
  const io = scripted(['1', 'r', 'no', codeNow(env.created)]);
  await runOperatorSession({ pin: env.pin, ...io });
  const again = scripted([]);
  await runOperatorSession({ pin: env.pin, ...again });
  assert.match(again.printed.join('\n'), /nothing is waiting/i);
});
