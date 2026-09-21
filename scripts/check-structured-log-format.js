#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  shouldEmit,
  writeStructuredLog,
} = require('../lib/http/structured-log');

function main() {
  const original = process.env.HUQAN_LOG_LEVEL;
  try {
    process.env.HUQAN_LOG_LEVEL = 'debug';
    const lines = [];
    const logger = {
      debug: line => lines.push(line),
      info: line => lines.push(line),
      warn: line => lines.push(line),
      error: line => lines.push(line),
    };

    const token = [
      Buffer.from('{"alg":"HS256"}').toString('base64url'),
      Buffer.from('{"sub":"1"}').toString('base64url'),
      'signature',
    ].join('.');
    const record = writeStructuredLog(
      logger,
      'info',
      'verification.completed',
      { requestId: 'req-123e4567-e89b-42d3-a456-426614174000' },
      {
        reason: 'verified',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        errorCode: token,
      },
    );

    for (const key of ['event', 'reason', 'request_id', 'timestamp', 'workspace_id', 'level']) {
      assert.equal(typeof record[key], 'string', `missing structured log field: ${key}`);
      assert.ok(record[key].length > 0, `empty structured log field: ${key}`);
    }
    assert.match(record.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(Number.isNaN(Date.parse(record.timestamp)), false, 'timestamp must be ISO-8601');
    assert.equal(record.workspace_id, 'workspace-1');
    assert.equal(record.agent_id, 'agent-1');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes(token), false, 'secret-looking material must not survive logging');

    process.env.HUQAN_LOG_LEVEL = 'warn';
    assert.equal(shouldEmit('debug'), false);
    assert.equal(shouldEmit('info'), false);
    assert.equal(shouldEmit('warn'), true);
    assert.equal(shouldEmit('error'), true);

    const filtered = [];
    writeStructuredLog({ info: line => filtered.push(line) }, 'info', 'filtered.info', {}, {});
    assert.equal(filtered.length, 0, 'HUQAN_LOG_LEVEL must filter lower-severity logs');

    console.log('structured-log-format: ok');
  } finally {
    if (original === undefined) delete process.env.HUQAN_LOG_LEVEL;
    else process.env.HUQAN_LOG_LEVEL = original;
  }
}

main();
