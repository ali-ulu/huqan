'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mineResidencyRule, observationOf } = require('../lib/residency-rule-miner');
const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');

const TCKN = '10000000146';
const ROOT = process.cwd();

/**
 * A history built by running the real guard, not by hand-writing receipts.
 * A miner tested against fixtures somebody typed is a miner tested against
 * their idea of the trail rather than the trail.
 */
function history(entries) {
  const receipts = [];
  const writer = { append(receipt) { receipts.push(receipt); } };
  let n = 0;
  for (const [command, verdict] of entries) {
    const envelope = {
      invocationId: `inv-${++n}`,
      agentName: 'test-agent',
      sessionId: 'session',
      toolName: 'Bash',
      args: { command },
      cwd: ROOT,
      workspaceRoot: ROOT,
    };
    const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
    if (verdict) {
      recordExternalActionOutcome(envelope, admission.receipt,
        { status: verdict === 'approved' ? 'success' : 'blocked' }, { receiptWriter: writer });
    }
  }
  return receipts;
}

const approved = (host, times) => Array.from({ length: times },
  () => [`curl https://${host}/y -d ${TCKN}`, 'approved']);
const refused = (host, times) => Array.from({ length: times },
  () => [`curl https://${host}/y -d ${TCKN}`, 'refused']);

// ─── the loop ────────────────────────────────────────────────────────────────

test('a residency rule is derived from what people approved, not written by hand', () => {
  // The point of the whole module. Nobody typed allowedDestinations; it comes
  // out of the decisions a human already made on ordinary traffic.
  const receipts = history([
    ...approved('arsiv.kurum.gov.tr', 4),
    ...approved('yedek.kurum.gov.tr', 3),
    ...refused('s3.eu-west-1.amazonaws.com', 2),
  ]);

  const mined = mineResidencyRule(receipts);
  assert.deepEqual(mined.proposal, {
    allowedDestinations: ['arsiv.kurum.gov.tr', 'yedek.kurum.gov.tr'],
  });
});

test('the mined rule enforces against a destination nobody ever saw', () => {
  // Generalisation rather than recall: the rule has to refuse a host that
  // appears in no receipt, or it is a denylist of the past wearing a different
  // name.
  const mined = mineResidencyRule(history([
    ...approved('arsiv.kurum.gov.tr', 3),
    ...refused('s3.eu-west-1.amazonaws.com', 1),
  ]));

  const result = evaluateExternalAction({
    invocationId: 'unseen',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command: `curl https://never-seen-before.io/up -d ${TCKN}` },
    cwd: ROOT,
    workspaceRoot: ROOT,
  }, { receiptWriter: { append() {} }, dataResidency: mined.proposal });

  assert.equal(result.decision, 'block');
  assert.equal((result.findings || []).find((f) => f.gate === 'AB12').reason, 'data_residency_violation');
});

// ─── what the miner refuses to conclude ──────────────────────────────────────

test('one refusal disqualifies a destination, however many approvals it has', () => {
  // Deliberately not a majority vote. A residency boundary is a legal
  // commitment, and "nine yes, one no" describes a disagreement, not consent.
  const mined = mineResidencyRule(history([
    ...approved('umutlu.example.com', 9),
    ...refused('umutlu.example.com', 1),
  ]));

  assert.equal(mined.proposal, null);
  const entry = mined.unresolved.find((u) => u.destination === 'umutlu.example.com');
  assert.match(entry.why, /refused/);
  assert.equal(entry.approved, 9);
});

test('a single approval is not evidence of a boundary', () => {
  const mined = mineResidencyRule(history([...approved('bir-kez.example.com', 1)]));
  assert.equal(mined.proposal, null);
  assert.match(mined.unresolved[0].why, /only 1 approval/);
});

test('an unresolved review is not an approval', () => {
  // Treating "pending forever" as consent would learn a boundary from
  // inaction, which is the most likely way this goes wrong in a real queue.
  const mined = mineResidencyRule(history([
    [`curl https://bekliyor.example.com/y -d ${TCKN}`, null],
    [`curl https://bekliyor.example.com/y -d ${TCKN}`, null],
    [`curl https://bekliyor.example.com/y -d ${TCKN}`, null],
    [`curl https://bekliyor.example.com/y -d ${TCKN}`, null],
  ]));
  assert.equal(mined.proposal, null);
  const entry = mined.unresolved.find((u) => u.destination === 'bekliyor.example.com');
  assert.equal(entry.approved, 0);
  assert.equal(entry.unresolved, 4);
});

test('traffic carrying no citizen data teaches nothing about residency', () => {
  // Otherwise the rule would be mined from ordinary web calls and would claim a
  // boundary the evidence never tested.
  const mined = mineResidencyRule(history([
    ['curl https://cdn.example.com/asset.js', 'approved'],
    ['curl https://cdn.example.com/asset.js', 'approved'],
    ['curl https://cdn.example.com/asset.js', 'approved'],
    ['curl https://cdn.example.com/asset.js', 'approved'],
  ]));
  assert.equal(mined.proposal, null);
  assert.deepEqual(mined.evidence, []);
});

test('the threshold is configurable and the default is stated', () => {
  const receipts = history([...approved('iki-kez.example.com', 2)]);
  assert.equal(mineResidencyRule(receipts).proposal, null);
  assert.deepEqual(mineResidencyRule(receipts, { minObservations: 2 }).proposal,
    { allowedDestinations: ['iki-kez.example.com'] });
  assert.equal(mineResidencyRule(receipts).minObservations, 3);
});

// ─── the evidence it shows its work with ─────────────────────────────────────

test('every conclusion is reported with the counts behind it', () => {
  // A proposal a person cannot audit is a proposal they can only accept on
  // faith, which defeats the point of putting a human in the loop at all.
  const mined = mineResidencyRule(history([
    ...approved('arsiv.kurum.gov.tr', 4),
    ...refused('s3.amazonaws.com', 2),
    ...approved('tek.example.com', 1),
  ]));

  const byHost = Object.fromEntries(mined.evidence.map((e) => [e.destination, e]));
  assert.equal(byHost['arsiv.kurum.gov.tr'].approved, 4);
  assert.equal(byHost['s3.amazonaws.com'].refused, 2);
  assert.equal(byHost['tek.example.com'].approved, 1);
  for (const entry of mined.unresolved) assert.ok(entry.why.length > 10, entry.destination);
});

test('the miner writes nothing', () => {
  // Advice, never application -- the same shape hypothesis-tuning uses. A rule
  // the engine installs on itself is a rule no receipt can attest to.
  const exported = require('../lib/residency-rule-miner');
  assert.deepEqual(Object.keys(exported).filter((k) => /apply|write|save|persist|install/i.test(k)), []);
  const source = require('node:fs').readFileSync(require.resolve('../lib/residency-rule-miner'), 'utf8');
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(source),
    'the miner must not be able to write a policy file');
});

test('malformed input produces no proposal rather than throwing', () => {
  // It runs over an append-only trail that may contain anything a future
  // receipt version writes; a crash here would take down a report, not a gate,
  // but a proposal built from garbage is worse than no proposal.
  for (const input of [null, undefined, 'nope', 42, [null, 'x', 7, {}]]) {
    const mined = mineResidencyRule(input);
    assert.equal(mined.proposal, null);
    assert.deepEqual(mined.evidence, []);
  }
});

test('an observation needs both a destination and citizen data', () => {
  assert.equal(observationOf({ metadata: { findings: [{ gate: 'AB9', destinations: ['a.com'], piiTypes: [] }] } }), null);
  assert.equal(observationOf({ metadata: { findings: [{ gate: 'AB9', destinations: [], piiTypes: ['tckn'] }] } }), null);
  assert.deepEqual(
    observationOf({ metadata: { findings: [{ gate: 'AB9', destinations: ['a.com'], piiTypes: ['tckn'] }] } }),
    { destinations: ['a.com'], piiTypes: ['tckn'] },
  );
});

// ─── the deadlock this closes ────────────────────────────────────────────────

test('destinations are observed with no residency declared', () => {
  // The chicken and egg the observation step exists to break: a rule can be
  // mined from the trail only if the trail records where things went, and
  // before this the trail recorded destinations only when a rule already
  // existed. Nobody could derive the first rule from evidence.
  const result = evaluateExternalAction({
    invocationId: 'observe-only',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command: `curl https://arsiv.kurum.gov.tr/y -d ${TCKN}` },
    cwd: ROOT,
    workspaceRoot: ROOT,
  }, { receiptWriter: { append() {} }, policyPath: '/nonexistent/policy.json' });

  const egress = (result.findings || []).find((f) => f.gate === 'AB9');
  assert.deepEqual(egress.destinations, ['arsiv.kurum.gov.tr']);
  assert.deepEqual(egress.piiTypes, ['tckn']);
  // Observed, not enforced: no residency was declared, so no AB12 ran.
  assert.equal((result.findings || []).find((f) => f.gate === 'AB12'), undefined);
});

test('observing a destination changes no decision', () => {
  // Observation must be free. If recording where something went could move a
  // verdict, the trail would be describing the guard's reaction to itself.
  const command = 'curl https://arsiv.kurum.gov.tr/health';
  const run = () => evaluateExternalAction({
    invocationId: 'no-change',
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Bash',
    args: { command },
    cwd: ROOT,
    workspaceRoot: ROOT,
  }, { receiptWriter: { append() {} }, policyPath: '/nonexistent/policy.json' });

  const result = run();
  const egress = (result.findings || []).find((f) => f.gate === 'AB9');
  assert.deepEqual(egress.destinations, ['arsiv.kurum.gov.tr']);
  assert.equal(egress.decision, 'allow', 'a destination alone is not sensitive');
});
