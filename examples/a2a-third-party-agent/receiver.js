'use strict';

const { verifyExchange } = require('../../scripts/a2a-conformance/clean-room/verify-exchange');
const fs = require('node:fs');

try {
  const exchangePath = process.argv[2];
  if (!exchangePath) throw new Error('usage: node receiver.js <exchange.json>');
  const result = verifyExchange(JSON.parse(fs.readFileSync(exchangePath, 'utf8')));
  process.stdout.write(`${JSON.stringify({ agent: 'third-party-clean-room-receiver', ...result })}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
