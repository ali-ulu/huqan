'use strict';

// Read-only coverage audit for #2505. Counts are evidence about available
// history, not an activation decision or a proof of receipt authenticity.
const fs = require('node:fs');
const readline = require('node:readline');
const { hasValidReceiptHash, isAdmissionReceipt } = require('../lib/autonomy-receipt-history');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

function requiredTimestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function createCoverageAudit(asOf) {
  const asOfMs = requiredTimestamp(asOf, 'asOf');
  const startMs = asOfMs - WINDOW_DAYS * DAY_MS;
  const counts = {
    lines: 0,
    malformedJson: 0,
    nonObject: 0,
    invalidTimestamp: 0,
    hashMismatch: 0,
    hashMatchingReceipts: 0,
    admissionReceipts: 0,
    admissionOutsideWindow: 0,
    windowAdmissions: 0,
    withSessionId: 0,
    withRunId: 0,
    withScore: 0,
    missingScore: 0,
    invalidScore: 0,
  };
  const byDay = new Map();
  let firstAdmissionMs = Infinity;
  let lastAdmissionMs = -Infinity;
  let firstScoredMs = Infinity;

  function addLine(line) {
    if (!line.trim()) return;
    counts.lines += 1;
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      counts.malformedJson += 1;
      return;
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      counts.nonObject += 1;
      return;
    }
    const createdAt = Date.parse(receipt.createdAt);
    if (!Number.isFinite(createdAt)) {
      counts.invalidTimestamp += 1;
      return;
    }
    if (!hasValidReceiptHash(receipt)) {
      counts.hashMismatch += 1;
      return;
    }
    counts.hashMatchingReceipts += 1;
    if (!isAdmissionReceipt(receipt)) return;
    counts.admissionReceipts += 1;
    firstAdmissionMs = Math.min(firstAdmissionMs, createdAt);
    lastAdmissionMs = Math.max(lastAdmissionMs, createdAt);
    if (createdAt < startMs || createdAt > asOfMs) {
      counts.admissionOutsideWindow += 1;
      return;
    }
    counts.windowAdmissions += 1;
    const day = new Date(createdAt).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
    if (typeof receipt.metadata?.sessionId === 'string' && receipt.metadata.sessionId.trim()) {
      counts.withSessionId += 1;
    }
    if (typeof receipt.metadata?.runId === 'string' && receipt.metadata.runId.trim()) {
      counts.withRunId += 1;
    }
    const score = receipt.metadata?.justification?.blastRadius?.score;
    if (score === undefined || score === null) {
      counts.missingScore += 1;
    } else if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
      counts.invalidScore += 1;
    } else {
      counts.withScore += 1;
      firstScoredMs = Math.min(firstScoredMs, createdAt);
    }
  }

  function finish() {
    const dailyAdmissions = [];
    const firstUtcDay = Math.floor(startMs / DAY_MS) * DAY_MS;
    const lastUtcDay = Math.floor(asOfMs / DAY_MS) * DAY_MS;
    for (let utcDay = firstUtcDay; utcDay <= lastUtcDay; utcDay += DAY_MS) {
      const date = new Date(utcDay).toISOString().slice(0, 10);
      dailyAdmissions.push({ date, count: byDay.get(date) || 0 });
    }
    return {
      version: 'huqan-impact-coverage-v1',
      scope: 'external-action admission receipts only',
      verification: 'canonical payload hash match only; issuer, chain and outcome are not verified',
      window: {
        days: WINDOW_DAYS,
        startInclusive: new Date(startMs).toISOString(),
        asOfInclusive: new Date(asOfMs).toISOString(),
        firstAdmissionAt: Number.isFinite(firstAdmissionMs) ? new Date(firstAdmissionMs).toISOString() : null,
        lastAdmissionAt: Number.isFinite(lastAdmissionMs) ? new Date(lastAdmissionMs).toISOString() : null,
        firstScoredAt: Number.isFinite(firstScoredMs) ? new Date(firstScoredMs).toISOString() : null,
        dailyAdmissions,
      },
      counts,
    };
  }

  return { addLine, finish };
}

async function auditFile(filePath, asOf) {
  const audit = createCoverageAudit(asOf);
  const lines = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) audit.addLine(line);
  return audit.finish();
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--receipts' || argv[2] !== '--as-of') {
    throw new Error('usage: node scripts/audit-impact-replay-coverage.js --receipts <jsonl> --as-of <ISO timestamp>');
  }
  const report = await auditFile(argv[1], argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`impact coverage audit failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { createCoverageAudit, auditFile };
