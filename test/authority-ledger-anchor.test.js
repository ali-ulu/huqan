'use strict';

// #3940: the authority's ledger head is anchored in Rekor, and
// `huqan audit --authority` reports a ledger rolled back past its newest
// anchor, an entry dated after the log took it, and a log it cannot use.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityState, openAuthorityState } = require('../lib/authority/state-store');
const { openLedgerStore } = require('../lib/authority/ledger-store');
const { createAuthorityService } = require('../lib/authority/authority-service');
const { createAuthorityServer } = require('../lib/authority/http-server');
const { parseAuthorityPin } = require('../lib/authority/authority-pin');
const { keyIdFor } = require('../lib/authority/decision-envelope');
const { anchorStatement, anchorDigest, signAnchor, verifyAnchorSignature } = require('../lib/authority/anchor-statement');
const { createRekorAnchorClient, verifyLogEntry, REKOR_LOG_ID } = require('../lib/mcp/rekor-anchor-client');
const { fetchAuthorityLedger } = require('../lib/mcp/authority-ledger-provider');
const { compareAnchorsWithLedger } = require('../lib/authority-anchor-detection');
const { anchor } = require('../bin/huqan-authority');

const p256 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

// A Rekor v1 stand-in: keeps hashedrekord entries, signs each entry timestamp
// with its own log key and answers the search index by public key.
// Its clock moves one second per entry, so a later anchor is always the newer one.
function fakeRekor({ now } = {}) {
  const log = p256();
  const logID = crypto.createHash('sha256').update(log.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const entries = new Map();
  const state = { down: false, forged: [] };
  function entryFor(body, integratedTime, logIndex) {
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
    const payload = JSON.stringify({ body: encoded, integratedTime, logID, logIndex });
    const signedEntryTimestamp = crypto.sign('sha256', Buffer.from(payload), log.privateKey).toString('base64');
    return { body: encoded, integratedTime, logID, logIndex, verification: { signedEntryTimestamp } };
  }
  async function transport(method, route, body) {
    if (state.down) throw Object.assign(new Error('down'), { code: 'REKOR_UNAVAILABLE' });
    if (method === 'POST' && route === '/api/v1/log/entries') {
      const uuid = crypto.randomBytes(40).toString('hex');
      entries.set(uuid, entryFor(body, now ? now() : Math.floor(Date.now() / 1000) + entries.size, entries.size));
      return { status: 201, json: { [uuid]: entries.get(uuid) } };
    }
    if (method === 'POST' && route === '/api/v1/index/retrieve') {
      const wanted = body.publicKey.content;
      const hits = [...entries].filter(([, e]) => JSON.parse(Buffer.from(e.body, 'base64')).spec.signature.publicKey.content === wanted);
      return { status: 200, json: [...hits.map(([uuid]) => uuid), ...state.forged.map(([uuid]) => uuid)] };
    }
    if (method === 'POST' && route === '/api/v1/log/entries/retrieve') {
      const forged = new Map(state.forged);
      return { status: 200, json: body.entryUUIDs.map(uuid => ({ [uuid]: entries.get(uuid) || forged.get(uuid) })) };
    }
    return { status: 404, json: null };
  }
  return { state, entries, entryFor, client: () => createRekorAnchorClient({ transport, logKey: log.publicKey }) };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-anchor-'));
  const created = createAuthorityState({ dir: path.join(dir, 'state') });
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const servers = [];
  t.after(() => Promise.all(servers.map(s => new Promise(r => s.close(r)))).then(() => fs.rmSync(dir, { recursive: true, force: true })));
  const pinText = (port) => JSON.stringify({ v: 'huqan.authority.pin.v1', port, keyId: keyIdFor(created.signingPublicKeyPem),
    signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem, anchorKey: created.anchorPublicKeyPem });
  // (Re)starts the service over whatever the ledger file holds now, as a restart would.
  async function start() {
    const state = openAuthorityState({ dir: path.join(dir, 'state') });
    const service = createAuthorityService({ ledger: openLedgerStore({ file: ledgerFile }), state });
    const server = createAuthorityServer({ service, signingKey: state.signingKey });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const pin = parseAuthorityPin(pinText(server.address().port)).pin;
    return { service, pin, mode: { mode: 'service', boundary: 'env-override', pin } };
  }
  return { dir, ledgerFile, created, start };
}

function recordStops(service, count, from = 0) {
  for (let i = from; i < from + count; i += 1) {
    const answer = service.recordStop({ workspaceId: 'w', scope: 'workspace', agentId: null, reason: '', actor: 'operator:cli',
      localSeq: i, localHash: crypto.createHash('sha256').update(`stop-${i}`).digest('hex'), stoppedAt: new Date().toISOString() });
    assert.equal(answer.status, 201);
  }
}

async function audit(env, rekor) {
  const fetched = await fetchAuthorityLedger({ anchors: true }, { resolveMode: () => env.mode, createRekorClient: rekor.client });
  return compareAnchorsWithLedger(fetched.anchors);
}

test('an anchor statement is fixed bytes, and only the P-256 anchor key verifies it', () => {
  const head = { seq: 7, hash: 'a'.repeat(64) };
  assert.equal(anchorStatement(head), `{"v":"huqan.authority.anchor.v1","seq":7,"hash":"${'a'.repeat(64)}"}`);
  const key = p256();
  const signed = signAnchor(head, key.privateKey);
  assert.equal(signed.digest, anchorDigest(head));
  assert.equal(verifyAnchorSignature(head, signed.signature, key.publicKey), true);
  assert.equal(verifyAnchorSignature({ ...head, seq: 8 }, signed.signature, key.publicKey), false);
  assert.equal(verifyAnchorSignature(head, signed.signature, p256().publicKey), false);
  assert.throws(() => signAnchor(head, crypto.generateKeyPairSync('ed25519').privateKey), /P-256/);
  assert.throws(() => anchorStatement({ seq: -1, hash: 'a'.repeat(64) }), TypeError);
});

test('a real Rekor entry verifies under the pinned log key, and nothing altered does', () => {
  const [uuid, entry] = Object.entries(require('./fixtures/rekor-hashedrekord-entry.json'))[0];
  const signer = Buffer.from(JSON.parse(Buffer.from(entry.body, 'base64')).spec.signature.publicKey.content, 'base64').toString();
  assert.equal(entry.logID, REKOR_LOG_ID);
  assert.equal(verifyLogEntry(uuid, entry, signer).logIndex, entry.logIndex);
  assert.equal(verifyLogEntry(uuid, entry, p256().publicKey), null, 'made with another key');
  assert.equal(verifyLogEntry(uuid, { ...entry, integratedTime: entry.integratedTime - 3600 }, signer), null, 'time moved');
  assert.equal(verifyLogEntry(uuid, { ...entry, logIndex: entry.logIndex + 1 }, signer), null, 'index moved');
});

test('the pin carries the anchor key, and an anchor key that is not P-256 is refused', () => {
  const created = createAuthorityState({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-anchor-pin-')) });
  const base = { v: 'huqan.authority.pin.v1', port: 1, keyId: keyIdFor(created.signingPublicKeyPem),
    signingKey: created.signingPublicKeyPem, sealingKey: created.sealingPublicKeyPem };
  assert.equal(parseAuthorityPin(JSON.stringify(base)).pin.anchorKey, null, 'a pin from before #3940 still parses');
  assert.equal(parseAuthorityPin(JSON.stringify({ ...base, anchorKey: created.anchorPublicKeyPem })).pin.anchorKey.asymmetricKeyType, 'ec');
  const ed = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(parseAuthorityPin(JSON.stringify({ ...base, anchorKey: ed })).reason, 'pin_malformed');
});

test('the service signs its head only when it has one and holds the anchor key', async (t) => {
  const env = await setup(t);
  const { service, pin } = await env.start();
  assert.deepEqual([service.ledgerAnchor().status, service.ledgerAnchor().body.code], [409, 'LEDGER_EMPTY']);
  recordStops(service, 2);
  const { anchor: signed } = service.ledgerAnchor().body;
  assert.deepEqual([signed.seq, signed.hash], [1, service.ledgerHead().body.hash]);
  assert.equal(verifyAnchorSignature(signed, signed.signature, pin.anchorKey), true);
  const keyless = createAuthorityService({ ledger: openLedgerStore({ file: env.ledgerFile }),
    state: { ...openAuthorityState({ dir: path.join(env.dir, 'state') }), anchorKey: null } });
  assert.deepEqual([keyless.ledgerAnchor().status, keyless.ledgerAnchor().body.code], [503, 'ANCHOR_KEY_MISSING']);
});

test('anchor puts the head into the log, and audit finds it there and agrees', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 3);
  const rekor = fakeRekor();
  const done = await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client });
  assert.equal(done.code, 0, JSON.stringify(done.report));
  assert.deepEqual([done.report.seq, done.report.logIndex], [2, 0]);
  assert.deepEqual(await audit(live, rekor), []);

  recordStops(live.service, 2, 3);
  assert.deepEqual(await audit(live, rekor), [], 'entries after the anchor are fine');
});

test('audit reports a ledger rolled back past its newest anchor, or rewritten under it', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 3);
  const rekor = fakeRekor();
  assert.equal((await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client })).code, 0);

  // An elevated process cuts the last entry; the shorter chain still verifies.
  const lines = fs.readFileSync(env.ledgerFile, 'utf8').trim().split('\n');
  fs.writeFileSync(env.ledgerFile, `${lines.slice(0, 2).join('\n')}\n`);
  const rolled = await env.start();
  assert.deepEqual((await audit(rolled, rekor)).map(f => f.code), ['LEDGER_ROLLED_BACK']);

  // It appends again to the old length: the seq is back, its hash is not.
  recordStops(rolled.service, 1, 10);
  assert.deepEqual((await audit(rolled, rekor)).map(f => f.code), ['LEDGER_ROLLED_BACK']);
});

test('a rolled-back head anchored afterwards with the stolen anchor key does not hide the rollback', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 3);
  const rekor = fakeRekor();
  assert.equal((await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client })).code, 0);

  // Elevated: cut the ledger back, restart, and anchor the shorter head with the same key.
  const lines = fs.readFileSync(env.ledgerFile, 'utf8').trim().split('\n');
  fs.writeFileSync(env.ledgerFile, `${lines.slice(0, 2).join('\n')}\n`);
  const rolled = await env.start();
  assert.equal((await anchor({ resolveMode: () => rolled.mode, createRekorClient: rekor.client })).code, 0);
  assert.deepEqual((await audit(rolled, rekor)).map(f => f.code), ['LEDGER_ROLLED_BACK']);

  // Even if the honest anchor's head came back, the order of the anchors gives the forgery away.
  const key = p256();
  const regressed = compareAnchorsWithLedger({ unverified: 0, truncated: false, scanned: true, publicKey: key.publicKey,
    anchors: [
      { logIndex: 1, integratedTime: 100, match: { seq: 5, receiptHash: 'a'.repeat(64), at: new Date(0).toISOString() } },
      { logIndex: 2, integratedTime: 200, match: { seq: 3, receiptHash: 'b'.repeat(64), at: new Date(0).toISOString() } },
    ].map(a => ({ ...a, signature: signAnchor({ seq: a.match.seq, hash: a.match.receiptHash }, key.privateKey).signature })) });
  assert.deepEqual(regressed.map(f => [f.code, f.logIndexes]), [['ANCHOR_ORDER_REGRESSED', [2]]]);
});

test('anchor reports an authority it cannot reach as JSON, not a crash', async () => {
  const key = p256();
  const mode = { mode: 'service', pin: { anchorKey: key.publicKey } };
  const down = await anchor({ resolveMode: () => mode, createClient: () => ({ ledgerAnchor: async () => {
    throw Object.assign(new Error('refused'), { code: 'AUTHORITY_UNAVAILABLE' });
  } }), createRekorClient: fakeRekor().client });
  assert.deepEqual(down, { code: 2, report: { error: 'AUTHORITY_UNAVAILABLE' } });
});

test('audit reports an anchored entry dated after the log took it', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 1);
  // The log's clock is an hour behind the ledger's: the entry claims a time the log had not reached.
  const rekor = fakeRekor({ now: () => Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client })).code, 0);
  assert.deepEqual((await audit(live, rekor)).map(f => f.code), ['LEDGER_CLOCK_SKEW']);
});

test('an unreachable log and an entry that does not verify are reported, never passed', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 1);
  const rekor = fakeRekor();
  assert.equal((await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client })).code, 0);
  const [, real] = [...rekor.entries][0];
  rekor.state.forged.push(['f'.repeat(80), { ...real, integratedTime: real.integratedTime + 1 }]);
  assert.deepEqual((await audit(live, rekor)).map(f => f.code), ['ANCHOR_UNVERIFIED']);

  rekor.state.down = true;
  assert.deepEqual((await audit(live, rekor)).map(f => f.code), ['ANCHOR_LOG_UNAVAILABLE']);
  const refused = await anchor({ resolveMode: () => live.mode, createRekorClient: rekor.client });
  assert.deepEqual([refused.code, refused.report.error], [2, 'REKOR_UNAVAILABLE']);
});

test('anchor refuses without a pinned anchor key, and audit says anchoring is off', async (t) => {
  const env = await setup(t);
  const live = await env.start();
  recordStops(live.service, 1);
  const mode = { ...live.mode, pin: { ...live.pin, anchorKey: null } };
  const refused = await anchor({ resolveMode: () => mode, createRekorClient: fakeRekor().client });
  assert.deepEqual([refused.code, refused.report.error], [2, 'ANCHOR_KEY_NOT_PINNED']);
  // A service holding another anchor key than the pin names publishes nothing.
  const otherPin = { ...live.mode, pin: { ...live.pin, anchorKey: p256().publicKey } };
  const rekor = fakeRekor();
  const mismatched = await anchor({ resolveMode: () => otherPin, createRekorClient: rekor.client });
  assert.deepEqual([mismatched.code, mismatched.report.error, rekor.entries.size], [2, 'ANCHOR_UNVERIFIED', 0]);
  const fetched = await fetchAuthorityLedger({ anchors: true }, { resolveMode: () => mode, createRekorClient: fakeRekor().client });
  assert.deepEqual(compareAnchorsWithLedger(fetched.anchors).map(f => f.code), ['ANCHOR_LOG_UNAVAILABLE']);
  assert.equal(compareAnchorsWithLedger(undefined).length, 0, 'not asked for, nothing to report');
});

test('an anchor older than the fetched window is found by reading the ledger from its start', async () => {
  const key = p256();
  const hashOf = seq => crypto.createHash('sha256').update(`entry-${seq}`).digest('hex');
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const total = 12_000;
  const entryAt = seq => ({ seq, type: 'note', at, body: {}, receiptHash: hashOf(seq) });
  const reads = [];
  const ledgerClient = (limitTo = total) => ({
    ledgerHead: async () => ({ status: 200, body: { seq: total - 1 } }),
    ledgerEntries: async ({ fromSeq, limit }) => {
      reads.push(fromSeq);
      const end = Math.min(fromSeq + limit, limitTo);
      return { status: 200, body: { corrupt: false, entries: Array.from({ length: Math.max(0, end - fromSeq) }, (_, i) => entryAt(fromSeq + i)) } };
    },
  });
  const signed = signAnchor({ seq: 100, hash: hashOf(100) }, key.privateKey);
  const rekorWith = digest => () => ({ findAnchors: async () => ({ unverified: 0, truncated: false,
    anchors: [{ uuid: 'u', logIndex: 9, integratedTime: Math.floor(Date.now() / 1000), digest, signature: signed.signature }] }) });
  const run = (client, digest) => fetchAuthorityLedger({ anchors: true }, { resolveMode: () => ({ mode: 'service', pin: { anchorKey: key.publicKey } }),
    createClient: () => client, createRekorClient: rekorWith(digest) }).then(f => compareAnchorsWithLedger(f.anchors).map(x => x.code));

  assert.deepEqual(await run(ledgerClient(), signed.digest), [], 'seq 100 sits before the 10,000-entry window and is found');
  assert.ok(reads.includes(0), 'the ledger was read from its start');
  assert.deepEqual(await run(ledgerClient(), anchorDigest({ seq: 100, hash: 'b'.repeat(64) })), ['LEDGER_ROLLED_BACK']);
});
