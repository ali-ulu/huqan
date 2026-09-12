'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeHookInvocation } = require('../lib/external-action-adapter');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { buildExternalActionAdmissionReceipt } = require('../lib/external-action-receipt');
const { recordBrowserHookOutcome, pagePreviewConsent } = require('../lib/browser-hook-outcome');

function fixture(t, content = 'PAGE BODY TEXT') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-page-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const payload = { hook_event_name: 'PostToolUse', tool_use_id: 'browser-1', session_id: 'session-1',
    tool_name: 'mcp__browser__navigate', tool_input: { url: 'https://example.com/page?token=private' },
    cwd: root, tool_response: { content } };
  const envelope = normalizeExternalActionEnvelope(normalizeHookInvocation('claude-code', payload));
  const admission = buildExternalActionAdmissionReceipt(envelope, { decision: 'allow', reason: 'fixture', findings: [] });
  const receiptPath = path.join(root, 'receipts.jsonl');
  fs.writeFileSync(receiptPath, JSON.stringify(admission) + '\n');
  const receiptWriter = Object.assign(receipt => { fs.appendFileSync(receiptPath, JSON.stringify(receipt) + '\n'); return true; }, { path: receiptPath });
  return { root, payload, receiptPath, admission, receiptWriter };
}

function lines(receiptPath) {
  return fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
}

test('without consent the trail stays hash-only: no page content, no preview receipt', t => {
  const f = fixture(t, 'SECRET PAGE BODY');
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter });
  assert.equal(result.ok, true);
  assert.equal(result.previewReceiptId, undefined);
  const trail = lines(f.receiptPath);
  assert.equal(trail.length, 2);
  assert.equal(JSON.stringify(trail).includes('SECRET PAGE BODY'), false);
});

test('payload-declared consent is ignored: only the deployment can consent', t => {
  const f = fixture(t);
  recordBrowserHookOutcome('claude-code', { ...f.payload, page_preview_consent: true, consent: 'text' },
    { receiptWriter: f.receiptWriter });
  const trail = lines(f.receiptPath);
  assert.equal(trail.length, 2);
  assert.equal(trail.some(receipt => receipt.receiptKind === 'browser_page_preview_receipt'), false);
});

test('consented text preview stores a bounded, sanitized snippet bound to the outcome', t => {
  const f = fixture(t, `Okay body line\nsk-live-abcdefghijklmnop1234\n${'x'.repeat(3000)}`);
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter, pagePreview: 'text' });
  assert.equal(result.ok, true);
  assert.match(String(result.previewReceiptId), /^browser_prev_/);
  const trail = lines(f.receiptPath);
  assert.equal(trail.length, 3);
  const preview = trail[2];
  assert.equal(preview.receiptKind, 'browser_page_preview_receipt');
  assert.equal(preview.status, 'preview');
  assert.equal(preview.metadata.outcomeReceiptId, trail[1].receiptId);
  assert.equal(preview.metadata.outcomeReceiptHash, trail[1].receiptHash);
  assert.equal(preview.metadata.destination.url, 'https://example.com/page');
  assert.equal(preview.metadata.consentSource, 'options');
  assert.equal(preview.metadata.text.truncated, true);
  assert.ok(preview.metadata.text.snippet.length <= 2048);
  assert.match(preview.metadata.text.snippet, /\[REDACTED\]/);
  assert.equal(JSON.stringify(trail).includes('sk-live-abcdefghijklmnop1234'), false);
  assert.equal(JSON.stringify(trail).includes('x'.repeat(3000)), false);
  assert.ok(JSON.stringify(preview).length <= 64 * 1024);
});

test('consented screenshot preview stores only the fingerprint, never the image', t => {
  const raw = Buffer.from('RAW SCREENSHOT BYTES').toString('base64');
  const f = fixture(t);
  f.payload.tool_response = { screenshot: raw };
  const result = recordBrowserHookOutcome('claude-code', f.payload,
    { receiptWriter: f.receiptWriter, pagePreview: { screenshot: true } });
  assert.equal(result.ok, true);
  const preview = lines(f.receiptPath)[2];
  assert.equal(preview.metadata.text, null);
  assert.equal(preview.metadata.screenshot.byteLength, 20);
  assert.match(preview.metadata.screenshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(lines(f.receiptPath)).includes(raw), false);
});

test('env-var consent is honored and labeled; empty object or bogus modes are not consent', t => {
  const f = fixture(t);
  process.env.HUQAN_BROWSER_PAGE_PREVIEW = 'text';
  t.after(() => { delete process.env.HUQAN_BROWSER_PAGE_PREVIEW; });
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter });
  assert.equal(result.ok, true);
  const preview = lines(f.receiptPath)[2];
  assert.equal(preview.metadata.consentSource, 'env');
  assert.equal(pagePreviewConsent({ pagePreview: { text: false, screenshot: false } }), null);
  assert.equal(pagePreviewConsent({ pagePreview: 'text,bogus' }), null);
});

test('failed browser outcomes are never previewed', t => {
  const f = fixture(t);
  const failedPayload = { ...f.payload, hook_event_name: 'PostToolUseFailure', error: 'NAV FAILED',
    tool_response: undefined };
  const failed = recordBrowserHookOutcome('claude-code', failedPayload,
    { receiptWriter: f.receiptWriter, pagePreview: 'text,screenshot' });
  assert.equal(failed.ok, true);
  assert.equal(failed.previewReceiptId, undefined);
  assert.equal(lines(f.receiptPath).length, 2);
});

test('repeat successful calls never duplicate the preview', t => {
  const f = fixture(t);
  const ok = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter, pagePreview: 'text' });
  assert.equal(ok.previewReceiptId !== undefined, true);
  const duplicate = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter, pagePreview: 'text' });
  assert.deepEqual(duplicate, { ok: true, duplicate: true });
  assert.equal(lines(f.receiptPath).length, 3);
});

test('real CLI writes a preview only when --page-preview is passed by the deployment', t => {
  const f = fixture(t);
  const run = (receiptPath, extraArgs = []) => spawnSync(process.execPath, [path.resolve(__dirname, '../bin/huqan-gate-hook.js'), 'browser-outcome',
    '--profile', 'claude-code', '--receipt-log', receiptPath,
    '--memory-path', path.join(f.root, 'memory.json'), '--db-path', path.join(f.root, 'memory.db'), ...extraArgs], {
    cwd: f.root, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify(f.payload),
  });
  assert.equal(run(f.receiptPath).status, 0);
  assert.equal(lines(f.receiptPath).length, 2);
  const previewPath = path.join(f.root, 'preview-receipts.jsonl');
  const admission2 = buildExternalActionAdmissionReceipt(
    normalizeExternalActionEnvelope(normalizeHookInvocation('claude-code', f.payload)),
    { decision: 'allow', reason: 'fixture', findings: [] });
  fs.writeFileSync(previewPath, JSON.stringify(admission2) + '\n');
  const child = run(previewPath, ['--page-preview', 'text']);
  assert.equal(child.status, 0, child.stderr);
  const trail = lines(previewPath);
  assert.equal(trail.length, 3);
  assert.equal(trail[2].receiptKind, 'browser_page_preview_receipt');
  assert.equal(trail[2].metadata.text.snippet, 'PAGE BODY TEXT');
});
