'use strict';

// Shared fixtures for the evidence-pack tests (#4092): a real emergency-stop
// ledger, built with the same entry hash the ledger itself uses, so a verifier
// is judged against bytes the producer could genuinely have written.

const { computeEntryHash } = require('../../lib/emergency-stop-chain');

function ledgerEntries(count = 2) {
  const entries = [];
  let prevHash = null;
  for (let seq = 0; seq < count; seq += 1) {
    const payload = {
      action: seq % 2 === 0 ? 'stop' : 'lift',
      scope: 'workspace',
      workspaceId: 'default',
      agentId: null,
      actor: 'operator:cli',
      reason: `fixture ${seq}`,
      createdAt: `2026-01-0${seq + 1}T00:00:00.000Z`,
    };
    const hash = computeEntryHash(payload, prevHash);
    entries.push({ ...payload, seq, prevHash, hash });
    prevHash = hash;
  }
  return entries;
}

function ledgerBytes(count = 2) {
  return ledgerEntries(count).map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

module.exports = { ledgerEntries, ledgerBytes };
