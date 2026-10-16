'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECEIPT_KIND,
  buildBrowserSessionReceipt,
  observationFromCdpMessage,
  observeBrowserSession,
  resolvePageTarget,
  validateCdpEndpoint,
} = require('../lib/browser-session-observer');
const { projectActivityEvent } = require('../lib/workbench/activity-read');

function messageEvent(payload) {
  const event = new Event('message');
  Object.defineProperty(event, 'data', { value: JSON.stringify(payload) });
  return event;
}

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.closed = false;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(raw) {
    const command = JSON.parse(raw);
    queueMicrotask(() => {
      this.dispatchEvent(messageEvent({ id: command.id, result: {} }));
      if (command.method !== 'Network.enable') return;
      this.dispatchEvent(messageEvent({
        method: 'Page.frameNavigated',
        params: { frame: { id: 'frame-secret-id', url: 'https://example.com/account?token=super-secret#private' } },
      }));
      this.dispatchEvent(messageEvent({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ value: 'console-secret' }, { value: 'second-secret' }] },
      }));
      this.dispatchEvent(messageEvent({
        method: 'Network.requestWillBeSent',
        params: {
          requestId: 'request-secret-id',
          type: 'Fetch',
          request: { method: 'POST', url: 'https://api.example.com/v1/send?api_key=never-store-me', postData: 'payload-secret' },
        },
      }));
      this.dispatchEvent(messageEvent({ method: 'Page.domContentEventFired', params: { timestamp: 123 } }));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

describe('browser session CDP boundary', () => {
  it('accepts only explicit loopback CDP endpoints', () => {
    assert.equal(validateCdpEndpoint('http://127.0.0.1:9222').hostname, '127.0.0.1');
    assert.equal(validateCdpEndpoint('ws://localhost:9222/devtools/page/abc').protocol, 'ws:');
    assert.throws(() => validateCdpEndpoint('https://browser.example.com/json'), /loopback-only/);
    assert.throws(() => validateCdpEndpoint('http://user:pass@127.0.0.1:9222'), /credentials/);
    assert.throws(() => validateCdpEndpoint('file:///tmp/socket'), /http\(s\) or ws\(s\)/);
  });

  it('discovers a page target without persisting title or raw target id', async () => {
    const target = await resolvePageTarget('http://127.0.0.1:9222', {
      fetchImpl: async url => {
        assert.equal(String(url), 'http://127.0.0.1:9222/json/list');
        return {
          ok: true,
          async json() {
            return [{
              id: 'raw-target-secret',
              type: 'page',
              title: 'Private customer dashboard',
              url: 'https://example.com/private?token=secret',
              webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/raw-target-secret',
            }];
          },
        };
      },
    });
    assert.equal(target.metadata.destination.url, 'https://example.com/private');
    assert.match(target.metadata.targetIdHash, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(target.metadata);
    assert.doesNotMatch(serialized, /raw-target-secret|Private customer dashboard|token=secret/);
  });
});

describe('browser session event sanitization', () => {
  it('maps CDP events to content-free metadata', () => {
    const navigation = observationFromCdpMessage({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'frame-1', url: 'https://example.com/docs?q=secret#fragment' } },
    });
    assert.equal(navigation.event, 'navigate');
    assert.equal(navigation.destination.url, 'https://example.com/docs');
    assert.match(navigation.targetIdHash, /^[0-9a-f]{64}$/);

    const consoleEvent = observationFromCdpMessage({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ value: 'do not persist me' }] },
    });
    assert.deepEqual(consoleEvent, {
      event: 'console', phase: 'api-call', consoleType: 'error', argumentCount: 1,
    });

    const network = observationFromCdpMessage({
      method: 'Network.requestWillBeSent',
      params: {
        requestId: 'request-1',
        type: 'XHR',
        request: { method: 'POST', url: 'https://api.example.com/send?token=nope', headers: { Authorization: 'secret' }, postData: 'secret-body' },
      },
    });
    assert.equal(network.destination.url, 'https://api.example.com/send');
    assert.equal(network.method, 'POST');
    assert.doesNotMatch(JSON.stringify(network), /Authorization|secret-body|token=nope/);
  });

  it('builds a canonical receipt bound to a browser session and optional outcome', () => {
    const receipt = buildBrowserSessionReceipt({
      sessionId: 'sess-2155',
      workspaceId: 'ws-1',
      agentName: 'codex',
      outcomeReceiptId: 'xact_out_123',
    }, {
      event: 'network',
      phase: 'response',
      destination: { scheme: 'https', host: 'example.com', path: '/ok', url: 'https://example.com/ok', truncated: false },
      statusCode: 204,
      requestIdHash: 'a'.repeat(64),
    }, { now: () => '2026-09-21T18:30:00.000Z', sequence: 1 });

    assert.equal(receipt.receiptKind, RECEIPT_KIND);
    assert.equal(receipt.admissionId, 'xact_out_123');
    assert.equal(receipt.metadata.outcomeReceiptId, 'xact_out_123');
    assert.equal(receipt.metadata.action, 'browser.network');
    assert.equal(receipt.metadata.destination.url, 'https://example.com/ok');
    assert.match(receipt.receiptHash, /^[0-9a-f]{64}$/);
  });
});

describe('browser session activity projection', () => {
  it('projects timeline metadata without inventing page content', () => {
    const receipt = buildBrowserSessionReceipt({
      sessionId: 'sess-project',
      workspaceId: 'ws-project',
      agentName: 'codex',
      outcomeReceiptId: 'xact_out_project',
    }, {
      event: 'network',
      phase: 'response',
      destination: { scheme: 'https', host: 'example.com', path: '/result', url: 'https://example.com/result', truncated: false },
      statusCode: 200,
      requestIdHash: 'b'.repeat(64),
    }, { now: () => '2026-09-21T18:31:00.000Z', sequence: 1 });
    const projected = projectActivityEvent({
      auditId: receipt.receiptId,
      eventType: String(receipt.receiptKind).toUpperCase(),
      targetType: 'external_agent_action',
      targetId: receipt.admissionId,
      workspaceId: receipt.workspaceId,
      actor: receipt.actor,
      timestamp: receipt.createdAt,
      sourceRef: receipt.receiptHash,
      provenanceId: receipt.provenanceId,
      trustPolicyVersion: receipt.trustPolicyVersion,
      details: receipt,
    });
    assert.equal(projected.action, 'browser.network');
    assert.equal(projected.receipt.receiptKind, RECEIPT_KIND);
    assert.equal(projected.receipt.browserSession.sessionId, 'sess-project');
    assert.equal(projected.receipt.browserSession.outcomeReceiptId, 'xact_out_project');
    assert.equal(projected.receipt.browserSession.destination.url, 'https://example.com/result');
    assert.equal(projected.receipt.browserSession.statusCode, 200);
  });
});

describe('runtime browser session observation', () => {
  it('is opt-in and persists only sanitized timeline receipts', async () => {
    const receipts = [];
    const writer = { append(receipt) { receipts.push(receipt); } };
    await assert.rejects(() => observeBrowserSession({
      endpoint: 'ws://127.0.0.1:9222/devtools/page/test',
      sessionId: 'sess-1',
      receiptWriter: writer,
      WebSocketClass: FakeWebSocket,
      durationMs: 5,
    }), /opt-in/);

    const result = await observeBrowserSession({
      enabled: true,
      endpoint: 'ws://127.0.0.1:9222/devtools/page/test',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      agentName: 'codex',
      outcomeReceiptId: 'xact_out_bound',
      receiptWriter: writer,
      WebSocketClass: FakeWebSocket,
      durationMs: 5,
    });

    assert.equal(result.ok, true);
    assert.ok(result.events >= 6);
    assert.equal(receipts[0].metadata.event, 'connection');
    assert.equal(receipts[0].metadata.phase, 'connected');
    assert.equal(receipts.at(-1).metadata.phase, 'closed');
    assert.ok(receipts.some(receipt => receipt.metadata.action === 'browser.navigate'));
    assert.ok(receipts.some(receipt => receipt.metadata.action === 'browser.console'));
    assert.ok(receipts.some(receipt => receipt.metadata.action === 'browser.network'));
    assert.ok(receipts.some(receipt => receipt.metadata.action === 'browser.dom'));
    for (const receipt of receipts) assert.equal(receipt.metadata.outcomeReceiptId, 'xact_out_bound');
    for (const receipt of receipts) assert.equal(receipt.metadata.outcomeBinding, 'reported');
    const serialized = JSON.stringify(receipts);
    for (const forbidden of ['super-secret', 'private', 'console-secret', 'second-secret', 'never-store-me', 'payload-secret', 'frame-secret-id', 'request-secret-id']) {
      assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'), 'leaked ' + forbidden);
    }
    const navigationReceipt = receipts.find(receipt => receipt.metadata.event === 'navigate');
    const networkRequestReceipt = receipts.find(receipt => receipt.metadata.event === 'network' && receipt.metadata.phase === 'request');
    assert.equal(navigationReceipt?.metadata.destination?.url, 'https://example.com/account');
    assert.equal(networkRequestReceipt?.metadata.destination?.url, 'https://api.example.com/v1/send');
  });
});
