'use strict';

// #4093 PR-B3: the export runner. It reads the receipt trail the guard already
// wrote, renders each admission receipt into the canonical SIEM event, and
// appends them to a sink. Two boundaries are asserted here, because they are
// what the scope note calls INV-B1 and INV-B4: the guard's own records are
// untouched by an export, and a sink that fails does not let the cursor move
// past an event that was never written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportReceiptsToSiem } = require('../lib/siem/siem-export');
const { SIEM_EVENT_SCHEMA_VERSION } = require('../lib/siem/siem-event');

function admissionReceipt(index, overrides = {}) {
  return {
    receiptId: `xact_adm_${String(index).padStart(4, '0')}`,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    workspaceId: 'ws-alpha',
    actor: 'codex',
    agentId: 'agent-7',
    trustPolicyVersion: 'huqan-external-action-guard-v1',
    reason: 'no_sensitive_payload',
    riskScore: 12,
    createdAt: `2026-10-21T15:0${index}:00.000Z`,
    receiptHash: String(index).repeat(64),
    metadata: {
      agentName: 'codex',
      toolName: 'fetch_page',
      toolKind: 'browser',
      inputDigest: 'b'.repeat(64),
      ruleIdentity: { ruleId: 'no_sensitive_payload' },
    },
    ...overrides,
  };
}

function trail(t, receipts) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-siem-export-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'receipts.jsonl');
  fs.writeFileSync(target, receipts.map(entry => JSON.stringify(entry)).join('\n') + (receipts.length ? '\n' : ''));
  return {
    base,
    path: target,
    siemPath: path.join(base, 'siem', 'huqan-events.jsonl'),
    cursorPath: path.join(base, 'siem', 'cursor.json'),
  };
}

function lines(target) {
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
}

test('exports pending receipts and advances cursor only after write', async t => {
  const paths = trail(t, [admissionReceipt(1), admissionReceipt(2)]);
  const report = await exportReceiptsToSiem({ ...paths, format: 'jsonl' });

  assert.equal(report.scanned, 2);
  assert.equal(report.pending, 2);
  assert.equal(report.exported, 2);
  assert.equal(report.failure, null);

  const written = lines(paths.siemPath).map(line => JSON.parse(line));
  assert.equal(written.length, 2);
  assert.equal(written[0]['huqan.schema_version'], SIEM_EVENT_SCHEMA_VERSION);
  assert.deepEqual(written.map(event => event['event.id']), ['xact_adm_0001', 'xact_adm_0002']);
  assert.equal(JSON.parse(fs.readFileSync(paths.cursorPath, 'utf8')).shipped, 2);

  const repeat = await exportReceiptsToSiem({ ...paths, format: 'jsonl' });
  assert.equal(repeat.pending, 0);
  assert.equal(lines(paths.siemPath).length, 2, 'an exported receipt is not exported twice');
});

test('re-run after crash does not lose events and duplicates share event.id', async t => {
  const paths = trail(t, [admissionReceipt(1), admissionReceipt(2)]);
  await exportReceiptsToSiem({ ...paths, format: 'jsonl' });

  // A crash between the write and the cursor update: the file has the events,
  // the cursor never learned about them.
  fs.rmSync(paths.cursorPath);

  const rerun = await exportReceiptsToSiem({ ...paths, format: 'jsonl' });
  assert.equal(rerun.exported, 2, 'the crash loses no event');

  const written = lines(paths.siemPath).map(line => JSON.parse(line)['event.id']);
  assert.deepEqual(written, ['xact_adm_0001', 'xact_adm_0002', 'xact_adm_0001', 'xact_adm_0002'],
    'a duplicate carries the same event.id, which is the key a collector dedupes on');
});

test('guard decision unchanged when sink throws', async t => {
  const paths = trail(t, [admissionReceipt(1), admissionReceipt(2)]);
  const before = fs.readFileSync(paths.path, 'utf8');

  const report = await exportReceiptsToSiem({
    ...paths,
    format: 'jsonl',
    sink: { kind: 'throwing', write() { throw new Error('sink is down'); } },
  });

  assert.ok(report.failure, 'the failure is reported');
  assert.match(report.failure.message, /sink is down/);
  assert.equal(report.exported, 0);
  assert.equal(fs.readFileSync(paths.path, 'utf8'), before, 'the export never writes to the guard trail');
  assert.equal(fs.existsSync(paths.cursorPath), false, 'the cursor does not move past an event that was not written');
});

test('performs no network call in file mode', async t => {
  const paths = trail(t, [admissionReceipt(1)]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the file sink must not open the network'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const report = await exportReceiptsToSiem({ ...paths, format: 'jsonl' });
  assert.equal(report.exported, 1);
  assert.equal(report.sink.kind, 'file');
});

test('renders the chosen format into the sink', async t => {
  const paths = trail(t, [admissionReceipt(1)]);
  await exportReceiptsToSiem({ ...paths, format: 'cef' });

  const [line] = lines(paths.siemPath);
  assert.match(line, /^CEF:0\|HUQAN\|huqan\|/);
  assert.match(line, /huqanEventId=xact_adm_0001/);
});

test('skips a receipt kind it cannot render instead of aborting the export', async t => {
  const paths = trail(t, [
    admissionReceipt(1),
    admissionReceipt(2, { receiptKind: 'external_action_outcome_receipt' }),
    admissionReceipt(3),
  ]);

  const report = await exportReceiptsToSiem({ ...paths, format: 'jsonl' });
  assert.equal(report.exported, 2, 'the admission receipts still flow');
  assert.equal(report.skippedReceipts, 1);
  assert.deepEqual(report.skippedReceiptKinds, { external_action_outcome_receipt: 1 },
    'the report names the kind that was stepped over, so an operator can see why');
  assert.deepEqual(lines(paths.siemPath).map(line => JSON.parse(line)['event.id']),
    ['xact_adm_0001', 'xact_adm_0003']);
});

test('refuses an unknown format before it reads or writes anything', async t => {
  const paths = trail(t, [admissionReceipt(1)]);
  await assert.rejects(
    () => exportReceiptsToSiem({ ...paths, format: 'ocsf' }),
    (error) => error.code === 'SIEM_UNSUPPORTED_FORMAT',
  );
  assert.equal(fs.existsSync(paths.siemPath), false);
  assert.equal(fs.existsSync(paths.cursorPath), false);
});

test('refuses a log or cursor that names the receipt trail', async t => {
  const paths = trail(t, [admissionReceipt(1)]);

  await assert.rejects(
    () => exportReceiptsToSiem({ ...paths, siemPath: paths.path, format: 'jsonl' }),
    (error) => error.code === 'SIEM_PATH_COLLISION',
  );
  await assert.rejects(
    () => exportReceiptsToSiem({ ...paths, cursorPath: paths.path, format: 'jsonl' }),
    (error) => error.code === 'SIEM_PATH_COLLISION',
  );
  assert.equal(fs.readFileSync(paths.path, 'utf8').includes('huqan.siem-event.v1'), false,
    'the guard trail is left exactly as it was');
});

test('refuses a cursor that is a symlink to the receipt trail', async t => {
  const paths = trail(t, [admissionReceipt(1)]);
  const link = path.join(paths.base, 'cursor-link.json');
  try {
    fs.symlinkSync(paths.path, link);
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST')) {
      t.skip('this platform does not allow symlinks here');
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => exportReceiptsToSiem({ ...paths, cursorPath: link, format: 'jsonl' }),
    (error) => error.code === 'SIEM_PATH_COLLISION',
  );
  assert.equal(fs.readFileSync(paths.path, 'utf8').includes('huqan.siem-event.v1'), false,
    'the guard trail is not truncated through a symlinked cursor');
});

test('a dry run reports the pending events and writes nothing', async t => {
  const paths = trail(t, [admissionReceipt(1), admissionReceipt(2)]);
  const report = await exportReceiptsToSiem({ ...paths, format: 'jsonl', dryRun: true });

  assert.equal(report.pending, 2);
  assert.equal(report.exported, 0);
  assert.equal(fs.existsSync(paths.siemPath), false);
  assert.equal(fs.existsSync(paths.cursorPath), false);
});

test('a dry run previews the receipt kinds that will not reach the SIEM', async t => {
  const paths = trail(t, [
    admissionReceipt(1),
    admissionReceipt(2, { receiptKind: 'external_action_outcome_receipt' }),
  ]);

  const report = await exportReceiptsToSiem({ ...paths, format: 'jsonl', dryRun: true });
  assert.equal(report.skippedReceipts, 1);
  assert.deepEqual(report.skippedReceiptKinds, { external_action_outcome_receipt: 1 },
    'the preview answers the same question a real run answers');
});
