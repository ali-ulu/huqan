'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toBrowserEvent } = require('./examples/browser-observation-client');

describe('browser observation spike', () => {
  it('maps a click to a page-level envelope', () => {
    const event = toBrowserEvent({
      agentId: 'browser-agent',
      runId: 'run-b1',
      stepId: 'step-3',
      browserAction: 'browser.clicked',
      page: 'shop.example/cart',
      element: 'add-button',
    });
    assert.strictEqual(event.schemaVersion, 'huqan.external-event.v1');
    assert.strictEqual(event.target, 'page:shop.example/cart#add-button');
    assert.match(event.input_hash, /^[0-9a-f]{64}$/);
  });

  it('hints review for payment targets, never silent allow', () => {
    const event = toBrowserEvent({
      agentId: 'browser-agent',
      runId: 'run-b1',
      stepId: 'step-9',
      browserAction: 'browser.clicked',
      page: 'shop.example/checkout',
      element: 'pay-button',
    });
    assert.strictEqual(event.decision, 'review');
  });

  it('is fail-closed on missing page', () => {
    assert.throws(() => toBrowserEvent({ agentId: 'a', runId: 'r', stepId: 's', browserAction: 'browser.clicked' }), /required/);
  });
});
