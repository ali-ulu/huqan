// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * Evidence-pack control matrix and auditor README (#4092, PR-A3).
 *
 * The matrix maps SOC 2 Trust Services Criteria to the files in a pack that are
 * relevant to them, and to the code that produces those files. It is static
 * data on purpose: nothing here inspects a running installation, so nothing
 * here can drift into claiming more than the table says.
 *
 * Every row is `supporting_evidence` and carries its own `nonClaim`. The
 * wording is deliberately flat: a row says what kind of record the pack holds,
 * never that a criterion is met. The criteria HUQAN produces no evidence for
 * are listed too, so an auditor does not have to infer the gap.
 *
 * Both renderers are pure and deterministic: the same input yields the same
 * bytes, so the matrix and the README hash the same way on every run.
 */

const { INTEGRITY_CLASSES, PACK_NON_CLAIMS } = require('./manifest');

const CONTROL_MATRIX_SCHEMA_VERSION = 'huqan.control-matrix.v1';
const RELEVANCE = 'supporting_evidence';

const RECEIPTS = 'external-actions/receipts.jsonl';
const BUNDLE = 'receipts/receipt-bundle.json';

const row = (tsc, criterion, evidence, evidenceFiles, sources, scope) => Object.freeze({
  tsc,
  criterion,
  evidence,
  evidenceFiles: Object.freeze(evidenceFiles),
  sources: Object.freeze(sources),
  relevance: RELEVANCE,
  nonClaim: `Records of ${scope} only. They do not show that the control for ${tsc} was designed well or operated over the period.`,
});

const CONTROL_ROWS = Object.freeze([
  row('CC6.1', 'Logical access controls',
    'The invariants document names the access boundaries the code enforces; receipts record the approval state of each external action.',
    [BUNDLE, 'config/security-invariants.md'],
    ['lib/http/route-auth-policy.js:261-314'], 'the access boundaries in force'),
  row('CC6.2/CC6.3', 'Authorization of access and its changes',
    'Admission receipts carry approvalId and approvalStatus, so a reviewer can see which actions required approval.',
    [BUNDLE, RECEIPTS],
    ['lib/external-action-receipt-admission.js:180-181'], 'approval state'),
  row('CC6.6', 'Restriction of outbound traffic and data movement',
    'Receipts list the AB9, AB12, AB13 and AB14 egress findings raised for each action.',
    [RECEIPTS],
    ['lib/external-action-egress-gates.js:58-154'], 'egress findings'),
  row('CC6.7', 'Restriction of data transmission to declared destinations',
    'Residency block receipts show actions refused because a destination fell outside the declared residency.',
    [BUNDLE, RECEIPTS],
    ['lib/data-residency-gate.js:165-204'], 'residency decisions'),
  row('CC6.8', 'Prevention of unauthorized actions',
    'Rejection receipts record each action the guard refused and the reason.',
    [BUNDLE, RECEIPTS],
    ['lib/external-action-receipt-admission.js:166-170'], 'refused actions'),
  row('CC7.2', 'Monitoring for anomalies',
    'Audit events and receipts record guard decisions; the observability alert code is the producer of alert records.',
    ['audit/audit-events.jsonl', RECEIPTS],
    ['lib/observability/alert-lifecycle.js:17-143', 'lib/observability/service-alert-rules.js:6-55'], 'recorded decisions'),
  row('CC7.3', 'Evaluation of security events',
    'Review receipts are paired with outcome receipts, so a reviewer can follow an event to its recorded outcome.',
    [BUNDLE, RECEIPTS],
    ['lib/external-action-receipt-outcome.js:164-226', 'lib/external-action-receipt-outcome.js:273-340'], 'event and outcome pairs'),
  row('CC7.4', 'Response to security incidents',
    'The emergency-stop ledger is a hash chain of stop and lift actions that a third party can re-walk.',
    ['emergency-stop/ledger.jsonl'],
    ['lib/emergency-stop-chain.js:55-79'], 'stop and lift actions'),
  row('CC7.5/A1.2', 'Recovery and backup',
    'The backup index lists the backups that exist. It is metadata only and is not a restore test.',
    ['backups/backup-index.json'],
    ['lib/storage/backup-restore-create.js:94-100'], 'backup existence'),
  row('CC8.1', 'Change management of the guard policy',
    'Receipts name the trust policy version and rule identity that decided each action; policy seals record the sealed policy.',
    [RECEIPTS, 'config/policy-seals.json'],
    [
      'lib/external-action-receipt-admission.js:179',
      'lib/external-action-receipt-admission.js:225-229',
      'docs/adr/ADR-015-signed-policy-and-transparency-log.md:28-57',
    ], 'policy versions'),
  row('CC4.1', 'Ongoing evaluation of controls',
    'The receipt chain and the collector seal chain show whether a break exists between records.',
    [BUNDLE, 'external-actions/collector-seals.jsonl'],
    ['lib/receipt/collector-seal.js:18-20'], 'chain continuity'),
]);

const OUT_OF_SCOPE_TSC = Object.freeze(['CC1.x', 'CC2.x', 'CC3.x', 'CC9.x', 'C1', 'P']);

const OUT_OF_SCOPE = Object.freeze(OUT_OF_SCOPE_TSC.map(tsc => Object.freeze({
  tsc,
  note: 'HUQAN does not produce evidence for this criterion.',
})));

/** The matrix as data. Frozen: callers cannot edit the table a pack ships. */
function buildControlMatrix() {
  return Object.freeze({
    schemaVersion: CONTROL_MATRIX_SCHEMA_VERSION,
    nonClaims: PACK_NON_CLAIMS,
    controls: CONTROL_ROWS,
    outOfScope: OUT_OF_SCOPE,
  });
}

/** The exact bytes written to `controls/control-matrix.json`. */
function renderControlMatrixJson() {
  return `${JSON.stringify(buildControlMatrix(), null, 2)}\n`;
}

const CLASS_TEXT = Object.freeze({
  [INTEGRITY_CLASSES.HASH_CHAINED]: [
    'Each record commits to the one before it. Proves: removing or editing a record breaks the chain a third party can re-walk from the start.',
    'Does not prove: that the recorded events happened, or that the operator did not write a whole new chain.',
  ],
  [INTEGRITY_CLASSES.COUNTER_SEALED]: [
    'A collector signed what it received. Proves: the collector held exactly this batch when it signed, and a removed batch leaves a gap in the seal chain.',
    'Does not prove: independence, unless the collector key is one the operator does not manage.',
  ],
  [INTEGRITY_CLASSES.ISSUER_SEALED]: [
    'The operator issuer key signed each record. Proves: the record came from the holder of that key.',
    'Does not prove: independence. The operator holds the key, so the seal speaks to origin, not to independence from the operator.',
  ],
  [INTEGRITY_CLASSES.SNAPSHOT_HASH_ONLY]: [
    'Only the manifest hash of this pack protects the file. Proves: the file is unchanged since the manifest was written.',
    'Does not prove: that the content was complete or accurate when it was taken.',
  ],
});

function renderClassSection() {
  return Object.values(INTEGRITY_CLASSES)
    .map(name => `### \`${name}\`\n\n${CLASS_TEXT[name].join('\n\n')}`)
    .join('\n\n');
}

/**
 * README-AUDITOR.md. It reads only the manifest fields that do not depend on
 * the README's own bytes (`period`, `generatedAt`, `producer`, `nonClaims`).
 * Listing `files` here would be circular: the manifest hashes this file.
 */
function renderAuditorReadme({ manifest } = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.nonClaims)) {
    throw new TypeError('renderAuditorReadme requires a manifest with nonClaims');
  }
  const { period = {}, generatedAt, producer = {} } = manifest;
  const rows = CONTROL_ROWS.map(r => `- ${r.tsc}: ${r.evidenceFiles.join(', ')}`).join('\n');
  const keyId = producer.issuerKeyId ? producer.issuerKeyId : 'none (unsigned pack)';
  return `# README for the auditor

This directory is an evidence pack produced by HUQAN on the operator's own
server. It holds the records a period produced, and a manifest that lets you
check the directory without trusting the producer.

- Period: ${period.from} to ${period.to}
- Generated: ${generatedAt}
- Producer: ${producer.product} ${producer.version}
- Issuer key id: ${keyId}

## What this pack is

Supporting evidence for some SOC 2 Trust Services Criteria, plus the means to
verify that the evidence was not altered after the manifest was written.
\`controls/control-matrix.json\` lists, per criterion, which files are relevant
and which source code produces them. HUQAN does not issue a SOC 2 report.

## What this pack is not

${manifest.nonClaims.map(c => `- ${c}`).join('\n')}

## What each integrity class proves

${renderClassSection()}

An issuer signature shows where a record came from. It does not show that the
issuer is independent of the operator. A transparency log, where one is
referenced, is checked for its shape only.

## Criteria with evidence in this pack

${rows}

Criteria outside the pack: ${OUT_OF_SCOPE_TSC.join(', ')}. HUQAN does not
produce evidence for them.

## How to verify

Run either verifier against this directory. Both are read-only, make no
network call, and exit 0 only when every check passes.

\`\`\`
huqan evidence verify <dir>
python3 verify_pack.py <dir>
\`\`\`

\`verify_pack.py\` ships under \`specs/huqan-evidence-pack/0.1/\` and needs only
the Python standard library. Its receipt-bundle check reuses \`verify_bundle.py\`
from \`specs/huqan-trust-protocol/0.2/conformance/\`. Collector seals can be
checked against the collector public key only if you obtain that key from a
channel other than this pack.
`;
}

module.exports = {
  CONTROL_MATRIX_SCHEMA_VERSION,
  buildControlMatrix,
  renderControlMatrixJson,
  renderAuditorReadme,
};
