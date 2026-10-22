'use strict';

/**
 * Evidence pack collector (#4092, PR-A2).
 *
 * Gathers one period of trust artifacts into a pack directory and seals it with
 * the A1 manifest. It owns no format and no check of its own: the receipt bundle
 * comes from the bounded exporter, the ledger is judged by the ledger's own chain
 * verifier, and the directory is read back by `verifyPack`. What it does decide:
 *
 *  - nothing leaves this module as a pack unless every check passed first. The
 *    whole pack is built in memory, written to a sibling temp directory and
 *    renamed into place, so a refusal leaves no output directory (INV-A3);
 *  - the bundle is written exactly as the bounded export serialized it, after
 *    `verifyExportedBundle` accepted those same bytes (INV-A2, INV-A6);
 *  - content a hash binds is never redacted: a secret-looking value there
 *    refuses the pack. Files only this manifest hashes are scrubbed (SI-03);
 *  - only the `default` workspace is packed (INV-A5) and nothing touches the
 *    network (INV-A1). No key is read and no signer exists here (INV-A4).
 */

const fs = require('node:fs');
const path = require('node:path');

const { INTEGRITY_CLASSES, PACK_NON_CLAIMS, fileEntry, buildManifest } = require('./manifest');
const { renderControlMatrixJson, renderAuditorReadme } = require('./control-matrix');
const { issuerKeyIdOf, signPackManifest } = require('./signature');
const { MAX_RECEIPTS, MAX_SERIALIZED_BUNDLE_BYTES, exportMaterializedReceiptBundleBounded } = require('../receipt/bounded-receipt-export');
const { DEFAULT_WORKSPACE_ID: CANONICAL_WORKSPACE_ID } = require('../workspace-id');
const { AUDIT_EVENT_DETAILS_LIMIT_CODE, iterateAuditEventsBounded } = require('../audit-bounded-read');
const { verifyExportedBundle } = require('../receipt/receipt-export');
const { ledgerPath, readLedgerEntries, verifyLedgerEntries } = require('../emergency-stop-chain');
const { readExternalActionReceiptsWithErrors } = require('../external-action-receipt-reader');
const { listBackups } = require('../../backupRestore');
const { hasSecretLookingValue } = require('../tool-call-gate-secrets');
const { scrubSecrets } = require('../secret-scrub-gate');
const { evaluateEgress } = require('../data-egress-gate');
const { COLLECTOR_SEALS_RELATIVE_PATH, readCollectorSealText } = require('./collector-seals');

const PACK_PATHS = Object.freeze({
  bundle: 'receipts/receipt-bundle.json',
  issuerSeals: 'receipts/issuer-seals.jsonl',
  externalReceipts: 'external-actions/receipts.jsonl',
  collectorSeals: COLLECTOR_SEALS_RELATIVE_PATH,
  ledger: 'emergency-stop/ledger.jsonl',
  audit: 'audit/audit-events.jsonl',
  invariants: 'config/security-invariants.md',
  policySeals: 'config/policy-seals.json',
  backups: 'backups/backup-index.json',
  selfCheck: 'verification/producer-self-check.json',
  controlMatrix: 'controls/control-matrix.json',
  auditorReadme: 'README-AUDITOR.md',
});

const AUDIT_PAGE_LIMIT = 500;
// shortcut: the audit snapshot is held in memory, so it is capped; raise it when
// a period legitimately needs more and the file can be streamed.
const MAX_AUDIT_EVENTS = 20000;
// A date, or a date-time that names its zone: a zone-less time would be read in the host's zone.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

class EvidencePackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidencePackError';
    this.code = code;
  }
}

function parsePeriod(from, to) {
  const parse = (value) => {
    const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
    if (!match) return Number.NaN;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const calendar = new Date(Date.UTC(year, month - 1, day));
    // Date.parse would roll 2026-02-30 over to March; the round trip refuses it.
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return Number.NaN;
    return Date.parse(value);
  };
  const start = parse(from);
  const end = parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new EvidencePackError('PERIOD_INVALID', 'from and to must be ISO-8601 dates or date-times with an explicit zone, with from <= to; bounds are inclusive instants and a date-only value means 00:00:00Z');
  }
  // The manifest records the window that was applied, not the text that was typed.
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), startMs: start, endMs: end };
}

const inPeriod = (period, timestamp) => {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && at >= period.startMs && at <= period.endMs;
};

const jsonl = (rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

/** Audit events of the period, oldest first, paged through the existing query. */
function readAuditSnapshot(graph, period) {
  const rows = [];
  let cursor;
  for (;;) {
    const page = graph.queryAuditEvents({ filters: { workspaceId: CANONICAL_WORKSPACE_ID }, order: 'asc', limit: AUDIT_PAGE_LIMIT, cursor });
    for (const event of page.items) {
      if (Date.parse(event.timestamp) > period.endMs) return rows;
      if (inPeriod(period, event.timestamp)) rows.push(event);
    }
    if (rows.length > MAX_AUDIT_EVENTS) {
      throw new EvidencePackError('MAX_AUDIT_EVENTS_EXCEEDED', `audit snapshot exceeds ${MAX_AUDIT_EVENTS} events`);
    }
    if (!page.hasMore) return rows;
    cursor = page.nextCursor;
  }
}

/** The receipt-bearing events of the period, read through the bounded iterator. */
function readReceiptSource(graph, period) {
  const events = [];
  try {
    for (const event of iterateAuditEventsBounded(graph, { workspaceId: CANONICAL_WORKSPACE_ID }, { maxDetailsBytes: MAX_SERIALIZED_BUNDLE_BYTES })) {
      const raw = event?.details?.receipt;
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && inPeriod(period, event.timestamp)) events.push(event);
    }
  } catch (error) {
    // An oversized or unreadable event is a refusal with a stable code, not a stack trace; the cause stays out of the message.
    const oversized = error?.code === AUDIT_EVENT_DETAILS_LIMIT_CODE;
    throw new EvidencePackError(oversized ? 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED' : 'RECEIPT_BUNDLE_READ_FAILED',
      oversized ? 'an audit event exceeds the serialized byte ceiling' : 'receipt source could not be read');
  }
  return events;
}

/** The bounded export, then a second verification of the exact bytes to be written. */
function exportBundleText(source, { exportBundle, generatedAt }) {
  const runExport = typeof exportBundle === 'function' ? exportBundle : exportMaterializedReceiptBundleBounded;
  const outcome = runExport(source, {
    workspaceId: CANONICAL_WORKSPACE_ID, maxReceipts: MAX_RECEIPTS, maxSerializedBundleBytes: MAX_SERIALIZED_BUNDLE_BYTES, exportedAt: generatedAt,
  });
  if (!outcome || outcome.ok !== true) {
    throw new EvidencePackError(outcome?.error?.code || 'RECEIPT_BUNDLE_READ_FAILED', outcome?.error?.message || 'receipt source could not be read');
  }
  // INV-A2: an export that did not report its own verification as valid never leaves here.
  if (outcome.verification?.valid !== true) {
    throw new EvidencePackError('BUNDLE_VERIFICATION_FAILED', 'exported receipt bundle failed verification');
  }
  const text = JSON.stringify(outcome.bundle);
  if (!verifyExportedBundle(JSON.parse(text)).valid) {
    throw new EvidencePackError('BUNDLE_VERIFICATION_FAILED', 'exported receipt bundle failed verification');
  }
  return { text, bundle: outcome.bundle };
}

/** The ledger whole -- a hash chain cannot be cut by period -- or null when none exists. */
function readLedger(emergencyStopDir) {
  const entries = readLedgerEntries(emergencyStopDir);
  if (entries.length === 0) return null;
  const chain = verifyLedgerEntries(entries);
  if (!chain.ok) throw new EvidencePackError('EMERGENCY_STOP_LEDGER_INVALID', `emergency-stop ledger does not verify: ${chain.reason}`);
  return { text: fs.readFileSync(ledgerPath(emergencyStopDir), 'utf8'), entries };
}

/**
 * Issuer seals are keyed by the durable receipt hash, which is not the bundle's
 * re-chained hash (see test/evidence-pack-seal-hash.test.js), so the durable
 * receipt is found by receiptId and its seal is packed as stored.
 */
function readIssuerSeals(graph, bundle) {
  if (typeof graph.getCommittedMutationReceiptById !== 'function') return [];
  const seals = [];
  for (const packed of bundle.receipts || []) {
    const durable = graph.getCommittedMutationReceiptById(packed.receiptId);
    const seal = durable ? graph.getMutationReceiptSealByHash(durable.receiptHash) : null;
    if (seal) seals.push(seal);
  }
  return seals;
}

/**
 * The collector's seal chains, whole (a chain cannot be cut by period), judged by the
 * collector's own chain verifier with keys from the separate channel. Null when not asked for.
 */
function readCollectorSeals(opts) {
  if (!opts.collectorStore) return null;
  if (!opts.collectorPubkeys) {
    throw new EvidencePackError('COLLECTOR_PUBKEYS_REQUIRED', 'a collector store is verified before it is packed; supply the collector public keys directory');
  }
  const outcome = readCollectorSealText(opts.collectorStore, opts.collectorPubkeys);
  if (outcome.error) throw new EvidencePackError('COLLECTOR_SEAL_CHAIN_INVALID', outcome.error);
  if (outcome.sealText === null) throw new EvidencePackError('COLLECTOR_SEALS_NOT_FOUND', 'the collector store holds no seals for the default workspace');
  return outcome.sealText;
}

function readBackupIndex(backupOptions) {
  const backups = listBackups(backupOptions).map((dir) => {
    let createdAt = null;
    try { createdAt = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).createdAt || null; } catch { createdAt = null; }
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, bytes: fs.statSync(path.join(dir, entry.name)).size }));
    return { id: path.basename(dir), createdAt, files };
  });
  return { schemaVersion: 'huqan.evidence-pack.backup-index.v1', note: 'metadata only: existence of a backup, not proof it restores', backups };
}

// A signature is public by construction, and a random base64 signature trips the
// secret heuristic about one time in five; the secret check reads what a
// signature covers, not the signature itself.
function withoutSignatures(value) {
  if (Array.isArray(value)) return value.map(withoutSignatures);
  if (!value || typeof value !== 'object') return value;
  const { signature, bundleSignature, ...rest } = value;
  return Object.fromEntries(Object.entries(rest).map(([key, inner]) => [key, withoutSignatures(inner)]));
}

function refuseSecrets(hashBound) {
  for (const [file, value] of hashBound) {
    if (hasSecretLookingValue(withoutSignatures(value))) {
      throw new EvidencePackError('EVIDENCE_PACK_SECRET_DETECTED', `a secret-looking value is bound by a hash in ${file}; the pack was not produced`);
    }
  }
}

/** Scrub a hash-less value; the file name is recorded when something was removed. */
function scrubbed(file, value, scrubbedFiles) {
  const result = scrubSecrets(value);
  if (result.secretDetected && !scrubbedFiles.includes(file)) scrubbedFiles.push(file);
  return result.scrubbed;
}

function writeAtomically(outDir, contents) {
  // mkdtemp beside the target (private 0700, unique name): the rename stays on one filesystem, hence atomic.
  let staging = null;
  try {
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    staging = fs.mkdtempSync(path.join(path.dirname(outDir), `.${path.basename(outDir)}-`));
    for (const [relative, content] of contents) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.renameSync(staging, outDir);
  } catch (error) {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    throw new EvidencePackError('PACK_WRITE_FAILED', `the pack could not be written (${error?.code || 'error'}); nothing was left behind`);
  }
}

/** Everything the pack will hold, read and checked; nothing has touched the output path yet. */
function gather(opts, period, generatedAt) {
  const { text: bundleText, bundle } = exportBundleText(readReceiptSource(opts.graph, period), { exportBundle: opts.exportBundle, generatedAt });
  const ledger = readLedger(opts.emergencyStopDir);
  const seals = readIssuerSeals(opts.graph, bundle);
  const collectorSeals = readCollectorSeals(opts);
  refuseSecrets([[PACK_PATHS.bundle, bundle], [PACK_PATHS.ledger, ledger ? ledger.entries : []], [PACK_PATHS.issuerSeals, seals]]);

  const scrubbedFiles = [];
  const audit = readAuditSnapshot(opts.graph, period).map((row) => scrubbed(PACK_PATHS.audit, row, scrubbedFiles));
  const external = readExternalActionReceiptsWithErrors({ path: opts.externalReceiptsPath });
  const externalRows = external.receipts
    .filter((row) => inPeriod(period, row.createdAt))
    .map((row) => scrubbed(PACK_PATHS.externalReceipts, row, scrubbedFiles));
  const invariantsPath = opts.securityInvariantsPath || path.join(__dirname, '..', '..', 'SECURITY_INVARIANTS.md');
  const invariants = scrubbed(PACK_PATHS.invariants, fs.readFileSync(invariantsPath, 'utf8'), scrubbedFiles);
  const piiTypes = [...new Set([bundle, ledger ? ledger.entries : [], seals, audit, externalRows]
    .flatMap((value) => evaluateEgress(value).piiTypes))].sort();
  return {
    bundleText, bundle, ledger, seals, collectorSeals, audit, externalRows, invariants, piiTypes, scrubbedFiles,
    unreadableExternalLines: external.unreadableLines,
    backupIndex: readBackupIndex(opts.backupOptions),
  };
}

const jsonFile = (value) => `${JSON.stringify(value)}\n`;

function selfCheck(g) {
  return `${JSON.stringify({
    schemaVersion: 'huqan.evidence-pack.self-check.v1',
    note: 'the producer re-ran its own checks; this is not an independent verification',
    receiptBundle: { verified: true, receiptCount: g.bundle.receiptCount },
    emergencyStopLedger: g.ledger ? 'chain verified' : 'absent',
    counts: {
      auditEvents: g.audit.length,
      externalActionReceipts: g.externalRows.length,
      unreadableExternalActionLines: g.unreadableExternalLines,
      issuerSeals: g.seals.length,
      collectorSeals: g.collectorSeals ? g.collectorSeals.split('\n').filter(Boolean).length : 0,
      backups: g.backupIndex.backups.length,
    },
    secretScan: 'no secret-looking value in hash-bound content',
    scrubbedFiles: g.scrubbedFiles,
  }, null, 2)}\n`;
}

/** [path, bytes, integrityClass] for every file, in the order they are listed. */
function packContents(g, readme) {
  const { HASH_CHAINED, ISSUER_SEALED, COUNTER_SEALED, SNAPSHOT_HASH_ONLY } = INTEGRITY_CLASSES;
  const policySeals = { schemaVersion: 'huqan.evidence-pack.policy-seals.v1', seals: [], note: 'this build persists no policy seals; ADR-015 verifies their shape only' };
  const contents = [
    [PACK_PATHS.bundle, g.bundleText, HASH_CHAINED],
    [PACK_PATHS.audit, jsonl(g.audit), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.externalReceipts, jsonl(g.externalRows), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.invariants, g.invariants, SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.policySeals, jsonFile(policySeals), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.backups, jsonFile(g.backupIndex), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.selfCheck, selfCheck(g), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.controlMatrix, renderControlMatrixJson(), SNAPSHOT_HASH_ONLY],
    [PACK_PATHS.auditorReadme, readme, SNAPSHOT_HASH_ONLY],
  ];
  if (g.ledger) contents.push([PACK_PATHS.ledger, g.ledger.text, HASH_CHAINED]);
  if (g.seals.length > 0) contents.push([PACK_PATHS.issuerSeals, jsonl(g.seals), ISSUER_SEALED]);
  if (g.collectorSeals) contents.push([PACK_PATHS.collectorSeals, g.collectorSeals, COUNTER_SEALED]);
  return contents;
}

/**
 * @param {object} opts
 * @param {string} opts.from ISO-8601 period start
 * @param {string} opts.to ISO-8601 period end
 * @param {string} opts.outDir pack directory to create; must not exist
 * @param {object} opts.graph the Graph whose audit log and receipts are packed
 * @param {string} opts.emergencyStopDir
 * @param {string} opts.externalReceiptsPath
 * @param {object} opts.backupOptions passed to listBackups
 * @param {string} [opts.collectorStore] collector store root; its default-workspace seal chains are packed whole
 * @param {string} [opts.collectorPubkeys] directory of collector public keys (separate channel, never packed); required with collectorStore
 * @param {string} [opts.workspaceId] only `default` is accepted
 * @param {{privateKeyPem: string}|null} [opts.issuerKey] the configured issuer key; when set the manifest is signed
 * @param {() => string} [opts.now]
 * @param {Function} [opts.exportBundle] test seam, as in the workbench exporter
 * @returns {{outDir: string, packHash: string, files: object[], piiTypes: string[]}}
 */
function collectEvidencePack(opts = {}) {
  if (opts.workspaceId !== undefined && opts.workspaceId !== CANONICAL_WORKSPACE_ID) {
    throw new EvidencePackError('WORKSPACE_NOT_ALLOWED', 'evidence packs support only the default workspace');
  }
  const period = parsePeriod(opts.from, opts.to);
  if (!opts.outDir) throw new EvidencePackError('OUT_DIR_REQUIRED', 'an output directory is required');
  const outDir = path.resolve(String(opts.outDir));
  if (fs.existsSync(outDir)) throw new EvidencePackError('OUT_DIR_EXISTS', 'the output directory already exists; the pack never overwrites');
  const generatedAt = (opts.now || (() => new Date().toISOString()))();

  const gathered = gather(opts, period, generatedAt);
  // The key id must be in the manifest before packHash is computed, so the seal covers it.
  const producer = { product: 'huqan', version: require('../../package.json').version, issuerKeyId: opts.issuerKey ? issuerKeyIdOf(opts.issuerKey.privateKeyPem) : null };
  const periodWindow = { from: period.from, to: period.to };
  // The manifest hashes the README, so the README reads only manifest fields that exist before the file list; buildManifest defaults nonClaims to PACK_NON_CLAIMS.
  const readme = renderAuditorReadme({ manifest: { period: periodWindow, generatedAt, producer, nonClaims: [...PACK_NON_CLAIMS] } });
  const contents = packContents(gathered, readme);
  const files = contents.map(([relative, content, integrityClass]) => fileEntry(relative, content, integrityClass))
    // Code-unit order, not localeCompare: the manifest must not depend on the host's locale.
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = buildManifest({
    period: periodWindow,
    generatedAt,
    workspaceId: CANONICAL_WORKSPACE_ID,
    producer,
    files,
    piiTypes: gathered.piiTypes,
  });
  const written = [...contents.map(([relative, content]) => [relative, content]), ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`]];
  if (opts.issuerKey) written.push(['manifest.signature.json', `${JSON.stringify(signPackManifest(manifest, opts.issuerKey.privateKeyPem), null, 2)}\n`]);
  writeAtomically(outDir, written);
  return { outDir, packHash: manifest.packHash, files, piiTypes: gathered.piiTypes, issuerKeyId: producer.issuerKeyId };
}

module.exports = { EvidencePackError, collectEvidencePack, PACK_PATHS };
