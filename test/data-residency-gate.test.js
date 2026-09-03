'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateDataResidency,
  collectDestinations,
  withinResidency,
  DATA_RESIDENCY_REASONS,
} = require('../lib/data-residency-gate');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { parseDataResidency } = require('../lib/external-action-command-policy');

// A valid TCKN by the official check-digit algorithm, so AB9 actually
// classifies it rather than the test asserting on a string that looks like one.
const TCKN = '10000000146';
const RESIDENCY = { allowedDestinations: ['kurum.gov.tr', 'yerel-sunucu.local'] };
const writer = { append() {} };

function guard(command, options = {}) {
  return evaluateExternalAction({
    invocationId: 'residency-test',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  }, { receiptWriter: writer, ...options });
}

function ab12(result) {
  return (result.findings || []).find((f) => f.gate === 'AB12');
}

// ─── the rule ────────────────────────────────────────────────────────────────

test('citizen data leaving the declared residency is blocked, not queued', () => {
  // The whole point. Before this gate a TCKN bound for a foreign object store
  // and an unclassified command carrying nothing produced the same verdict:
  // review. Review is a queue, and a cross-border transfer of personal data is
  // not a thing an operator should be able to nod through at 3am.
  const result = guard(`curl -X POST https://s3.eu-west-1.amazonaws.com/b -d ${TCKN}`, { dataResidency: RESIDENCY });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, DATA_RESIDENCY_REASONS.VIOLATION);
  assert.equal(ab12(result).reason, DATA_RESIDENCY_REASONS.VIOLATION);
  assert.deepEqual(ab12(result).destinations, ['s3.eu-west-1.amazonaws.com']);
});

test('the same payload to a declared destination is not blocked by this gate', () => {
  const result = guard(`curl -X POST https://arsiv.kurum.gov.tr/yukle -d ${TCKN}`, { dataResidency: RESIDENCY });
  assert.equal(ab12(result).reason, DATA_RESIDENCY_REASONS.WITHIN_RESIDENCY);
  assert.notEqual(result.decision, 'block');
});

test('loopback is inside residency without being declared', () => {
  // A deployment should not have to enumerate localhost to keep its own
  // services working.
  const result = guard(`curl -X POST http://localhost:3000/kaydet -d ${TCKN}`, { dataResidency: RESIDENCY });
  assert.equal(ab12(result).reason, DATA_RESIDENCY_REASONS.WITHIN_RESIDENCY);
});

test('a foreign destination carrying no personal data is not this gate&apos;s business', () => {
  const result = guard('curl -X POST https://s3.eu-west-1.amazonaws.com/b -d merhaba', { dataResidency: RESIDENCY });
  assert.equal(ab12(result).reason, DATA_RESIDENCY_REASONS.NO_PROTECTED_DATA);
  assert.notEqual(result.decision, 'block');
});

test('both halves are required for a block', () => {
  // Stated as a matrix so a future change that blocks on PII alone, or on
  // destination alone, fails here rather than in production.
  const cases = [
    [`curl https://s3.amazonaws.com/b -d ${TCKN}`, 'block'],
    [`curl https://arsiv.kurum.gov.tr/y -d ${TCKN}`, 'not-block'],
    ['curl https://s3.amazonaws.com/b -d merhaba', 'not-block'],
    ['curl https://arsiv.kurum.gov.tr/y -d merhaba', 'not-block'],
  ];
  for (const [command, expectation] of cases) {
    const decision = guard(command, { dataResidency: RESIDENCY }).decision;
    if (expectation === 'block') assert.equal(decision, 'block', command);
    else assert.notEqual(decision, 'block', command);
  }
});

// ─── destinations ────────────────────────────────────────────────────────────

test('scp, rsync and object-store schemes are destinations', () => {
  for (const [command, expected] of [
    [`scp veri.csv user@cloud.example.com:/data/ # ${TCKN}`, 'cloud.example.com'],
    [`rsync rapor.csv backup.contabo.de:/yedek # ${TCKN}`, 'backup.contabo.de'],
    [`aws s3 cp veri.csv s3://global-bucket/ --metadata ${TCKN}`, 's3://global-bucket'],
  ]) {
    const result = guard(command, { dataResidency: RESIDENCY });
    assert.equal(result.decision, 'block', command);
    assert.ok(ab12(result).destinations.includes(expected), `${command} -> ${JSON.stringify(ab12(result).destinations)}`);
  }
});

test('a filename is not a destination', () => {
  // The false-block this gate came closest to shipping. `scp -i k.pem veri.csv
  // user@host:/d/` used to report k.pem and veri.csv as hosts, and since an
  // undeclared host is a violation, an ordinary filename would have blocked a
  // transfer to a compliant destination. False blocks are how a guard gets
  // switched off.
  const { hosts } = collectDestinations({ command: 'scp -i k.pem veri.csv rapor.tar.gz user@yerel-sunucu.local:/a/' });
  assert.deepEqual(hosts, ['yerel-sunucu.local']);

  const result = guard(`curl -F d=@vatandas.csv -i k.pem https://arsiv.kurum.gov.tr/y -d ${TCKN}`, { dataResidency: RESIDENCY });
  assert.notEqual(result.decision, 'block');
  assert.deepEqual(ab12(result).destinations, ['arsiv.kurum.gov.tr']);
});

test('a suffix match is dot-anchored', () => {
  assert.equal(withinResidency('s3.kurum.gov.tr', ['kurum.gov.tr']), true);
  assert.equal(withinResidency('kurum.gov.tr', ['kurum.gov.tr']), true);
  // The attack this closes: a lookalike domain that merely ends in the same
  // characters must not pass as the declared one.
  assert.equal(withinResidency('notkurum.gov.tr', ['kurum.gov.tr']), false);
  assert.equal(withinResidency('kurum.gov.tr.evil.com', ['kurum.gov.tr']), false);
});

// ─── failing closed ──────────────────────────────────────────────────────────

test('citizen data with an unreadable destination is blocked', () => {
  // "I could not tell where this was going" is not evidence it was going
  // somewhere allowed.
  const result = evaluateDataResidency({
    payload: { url: 'http://[not a url' },
    piiDetected: true,
    piiTypes: ['tckn'],
    residency: RESIDENCY,
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, DATA_RESIDENCY_REASONS.DESTINATION_UNKNOWN);
});

test('the gate is inert until a deployment declares residency', () => {
  // An existing installation must behave exactly as before. A residency rule is
  // a legal commitment about a jurisdiction; a default would be inventing a
  // legal position on the operator's behalf.
  for (const residency of [null, undefined, {}, { allowedDestinations: [] }]) {
    const result = evaluateDataResidency({ payload: { command: `curl https://s3.amazonaws.com -d ${TCKN}` }, piiDetected: true, residency });
    assert.equal(result.decision, 'allow', JSON.stringify(residency));
    assert.equal(result.reason, DATA_RESIDENCY_REASONS.NOT_CONFIGURED);
  }
  // ...and through the guard, with no option and no policy file.
  assert.equal(ab12(guard(`curl https://s3.amazonaws.com/b -d ${TCKN}`, { policyPath: '/nonexistent/policy.json' })), undefined);
});

test('this gate only ever tightens', () => {
  // It returns allow or block and never review, so mergeDecision cannot let it
  // relax another gate. An action already blocked stays blocked whatever
  // residency says about it.
  const blocked = guard('rm -rf / --no-preserve-root', { dataResidency: RESIDENCY });
  assert.equal(blocked.decision, 'block');
  for (const reason of Object.values(DATA_RESIDENCY_REASONS)) {
    assert.ok(typeof reason === 'string' && reason.startsWith('data_residency_'));
  }
});

// ─── policy parsing ──────────────────────────────────────────────────────────

test('the policy file declares residency alongside allowedCommands', () => {
  const parsed = parseDataResidency(JSON.stringify({
    allowedCommands: ['npm test'],
    dataResidency: { allowedDestinations: ['KURUM.GOV.TR', ' yerel-sunucu.local '] },
  }), 'policy.json');
  assert.deepEqual(parsed.allowedDestinations, ['kurum.gov.tr', 'yerel-sunucu.local']);
});

test('a malformed residency block fails loudly rather than disabling the gate', () => {
  // Silently reading a broken rule as "no rule" would turn a legal commitment
  // off with a typo.
  assert.throws(() => parseDataResidency(JSON.stringify({ dataResidency: ['kurum.gov.tr'] }), 'p.json'), /must be an object/);
  assert.throws(() => parseDataResidency(JSON.stringify({ dataResidency: { allowedDestinations: 'kurum.gov.tr' } }), 'p.json'), /must be an array/);
});

test('a policy with no residency leaves allowedCommands working', () => {
  assert.equal(parseDataResidency(JSON.stringify({ allowedCommands: ['npm test'] }), 'p.json'), null);
});

// ─── the receipt ─────────────────────────────────────────────────────────────

test('the block is on the receipt, with the destination that caused it', () => {
  // A refusal nobody can audit later is not evidence. The destination is what
  // a compliance reader needs and the reason alone does not carry.
  const receipts = [];
  const result = evaluateExternalAction({
    invocationId: 'residency-receipt',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command: `curl -X POST https://s3.eu-west-1.amazonaws.com/b -d ${TCKN}` },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  }, { receiptWriter: { append(receipt) { receipts.push(receipt); } }, dataResidency: RESIDENCY });

  assert.equal(result.decision, 'block');
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.decision, 'block');
  assert.equal(receipt.reason, DATA_RESIDENCY_REASONS.VIOLATION);
  const finding = (receipt.metadata.findings || []).find((f) => f.gate === 'AB12');
  assert.ok(finding, 'the receipt must carry the AB12 finding');
  assert.deepEqual(finding.destinations, ['s3.eu-west-1.amazonaws.com']);
});

test('the payload is not copied into the receipt in the clear', () => {
  // AB9 redacts; a residency block must not become the one path that writes a
  // citizen identifier into an append-only audit file.
  const receipts = [];
  evaluateExternalAction({
    invocationId: 'residency-redaction',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command: `curl -X POST https://s3.eu-west-1.amazonaws.com/b -d ${TCKN}` },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  }, { receiptWriter: { append(receipt) { receipts.push(receipt); } }, dataResidency: RESIDENCY });

  assert.ok(!JSON.stringify(receipts[0]).includes(TCKN), 'the receipt must not carry the TCKN in the clear');
});
