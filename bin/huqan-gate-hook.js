#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  EXTERNAL_ADAPTER_PROFILES,
  evaluateHookInvocation,
} = require('../lib/external-action-adapter');
const { createDurableExternalActionReceiptWriter } = require('../lib/external-action-receipt');
const { queryExternalActionsByIdentity } = require('../lib/external-action-identity-log');

const MAX_STDIN_BYTES = 1024 * 1024;

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function readJsonFile(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

// Read-only audit mode: answer "what has this identity done?" from the same
// receipt trail the guard writes. No stdin, no receipt writer, no graph.
function queryIdentityLog() {
  const identityRef = argumentValue('--identity-log');
  const result = queryExternalActionsByIdentity({
    ...(identityRef.startsWith('agent:') ? { identityRef } : { agentId: identityRef }),
    ...(argumentValue('--receipt-log') ? { path: argumentValue('--receipt-log') } : {}),
    ...(argumentValue('--owner') ? { ownerActorId: argumentValue('--owner') } : {}),
    ...(argumentValue('--since') ? { since: argumentValue('--since') } : {}),
    ...(argumentValue('--until') ? { until: argumentValue('--until') } : {}),
    ...(argumentValue('--limit') ? { limit: Number.parseInt(argumentValue('--limit'), 10) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new Error('hook input exceeds 1 MiB'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let receiptWriter;
  try {
    if (argumentValue('--identity-log')) return queryIdentityLog();
    const profile = argumentValue('--profile', EXTERNAL_ADAPTER_PROFILES.GENERIC);
    const identityCardPath = argumentValue('--identity-card');
    const receiptPath = argumentValue('--receipt-log');
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    receiptWriter = createDurableExternalActionReceiptWriter({
      ...(receiptPath ? { path: receiptPath } : {}),
      memoryPath: argumentValue('--memory-path') || undefined,
      dbPath: argumentValue('--db-path') || undefined,
    });
    const evaluated = evaluateHookInvocation(profile, payload, {
      receiptWriter,
      workspaceRoot: argumentValue('--workspace-root') || undefined,
      workspaceId: argumentValue('--workspace-id', 'default'),
      agentName: argumentValue('--agent-name') || undefined,
      identityCard: identityCardPath ? readJsonFile(identityCardPath) : undefined,
      requireIdentityCard: process.argv.includes('--require-identity') ? true : undefined,
      graduatedAutonomy: process.argv.includes('--graduated-autonomy') ? {
        enabled: true,
        receiptPath: receiptWriter.path,
        ...(argumentValue('--autonomy-activation') ? {
          activation: {
            status: 'approved',
            approvalId: argumentValue('--autonomy-activation'),
            actor: argumentValue('--human-approver'),
            actorType: 'human',
            approvedAt: argumentValue('--approved-at'),
          },
        } : {}),
      } : undefined,
    });
    process.stdout.write(`${JSON.stringify(evaluated.projection.output)}\n`);
    process.exitCode = evaluated.projection.exitCode;
  } catch (error) {
    process.stderr.write(`HUQAN external action guard failed closed: ${error?.message || error}\n`);
    process.exitCode = 2;
  } finally {
    receiptWriter?.close?.();
  }
}

main();
