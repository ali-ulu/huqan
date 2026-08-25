'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  createFinding,
  normalizeFinding,
} = require('./finding-schema');
const { normalizeWorkspaceId } = require('../workspace-id');

const AUDIT_MODES = Object.freeze([
  'audit_only',
]);

const AUDIT_STATUSES = Object.freeze([
  'ready',
  'blocked',
]);

/**
 * The severities that make a report 'blocked' rather than 'ready'.
 *
 * 'blocked' was declared in AUDIT_STATUSES and produced nowhere: the status
 * field was `findings.length > 0 ? 'ready' : 'ready'`, so a report with two
 * critical findings carried the same status as an empty one and a consumer
 * branching on `status` could not tell them apart (#1543). The dead ternary
 * says the threshold was meant to exist; this is that threshold.
 */
const BLOCKING_FINDING_SEVERITIES = Object.freeze(['high', 'critical']);

/** 'blocked' when any finding is severe enough to stop on, else 'ready'. */
function auditStatusFor(findings) {
  return findings.some((finding) => BLOCKING_FINDING_SEVERITIES.includes(finding.severity))
    ? 'blocked'
    : 'ready';
}

const { isPlainObject } = require('../is-plain-object');
const { isInsideRoot } = require('./source-dependency-graph');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function normalizeRepoRoot(repoRoot) {
  return normalizeString(repoRoot);
}

function validateAuditOptions(opts = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const errors = [];
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const mode = normalizeString(options.mode, 'audit_only');
  const repoRoot = normalizeRepoRoot(options.repoRoot);

  if (!AUDIT_MODES.includes(mode)) {
    errors.push({ field: 'mode', code: 'VALIDATION_ERROR', message: `mode must be one of: ${AUDIT_MODES.join(', ')}` });
  }
  if (!repoRoot) {
    errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot is required' });
  } else {
    if (!path.isAbsolute(repoRoot)) {
      errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot must be an absolute path' });
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(repoRoot)) {
      errors.push({ field: 'repoRoot', code: 'VALIDATION_ERROR', message: 'repoRoot must not contain traversal segments' });
    }
  }
  if (options.outputPath) {
    // The message used to say "disabled in audit_only mode", but audit_only is
    // the only mode there is -- what gates this is the allowOutput flag, and
    // naming a mode distinction that does not exist misleads the reader.
    if (!options.allowOutput) {
      errors.push({ field: 'outputPath', code: 'VALIDATION_ERROR', message: 'outputPath requires allowOutput' });
    } else {
      // allowOutput used to skip path validation entirely, so '../../../etc/x'
      // came back ok:true. Nothing consumes outputPath yet, which is exactly
      // why it matters: the first consumer would inherit a path the validator
      // already called valid. repoRoot's own rules apply, plus containment.
      const outputPath = normalizeString(options.outputPath);
      if (!path.isAbsolute(outputPath)) {
        errors.push({ field: 'outputPath', code: 'VALIDATION_ERROR', message: 'outputPath must be an absolute path' });
      } else if (/(^|[\\/])\.\.([\\/]|$)/.test(outputPath)) {
        errors.push({ field: 'outputPath', code: 'VALIDATION_ERROR', message: 'outputPath must not contain traversal segments' });
      } else if (repoRoot && path.isAbsolute(repoRoot) && !isInsideRoot(repoRoot, outputPath)) {
        errors.push({ field: 'outputPath', code: 'VALIDATION_ERROR', message: 'outputPath must stay inside repoRoot' });
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    value: {
      workspaceId,
      mode,
      repoRoot,
      outputPath: options.outputPath ? normalizeString(options.outputPath) : null,
      allowOutput: Boolean(options.allowOutput),
    },
  };
}

function normalizeAuditFindings(findings, opts = {}) {
  if (findings == null) {
    return [];
  }
  if (!Array.isArray(findings)) {
    throw new TypeError('findings must be an array');
  }
  return findings.map((finding) => createFinding(finding, { workspaceId: opts.workspaceId }));
}

function createAuditReportId(input = {}) {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const mode = normalizeString(input.mode, 'audit_only');
  const repoRoot = normalizeRepoRoot(input.repoRoot);
  const findings = Array.isArray(input.findings) ? [...input.findings] : [];
  const canonical = findings
    .map((finding) => normalizeFinding(finding, { workspaceId }))
    .map((finding) => ({
      findingId: finding.findingId,
      kind: finding.kind,
      severity: finding.severity,
      title: finding.title,
      summary: finding.summary,
      evidence: finding.evidence,
      affectedFiles: finding.affectedFiles,
      suggestedTests: finding.suggestedTests,
      suggestedFix: finding.suggestedFix,
      riskFlags: finding.riskFlags,
      status: finding.status,
      workspaceId: finding.workspaceId,
    }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
  const payload = {
    workspaceId,
    mode,
    repoRoot,
    findings: canonical,
  };
  return `audit_${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)}`;
}

function createAuditReport(findings, opts = {}) {
  const validation = validateAuditOptions(opts);
  if (!validation.ok) {
    const error = new Error('Invalid audit options');
    error.validation = validation;
    throw error;
  }
  const normalizedFindings = normalizeAuditFindings(findings, validation.value)
    .map((finding) => normalizeFinding(finding, { workspaceId: validation.value.workspaceId }))
    .sort((a, b) => a.findingId.localeCompare(b.findingId));

  const report = {
    reportId: createAuditReportId({
      workspaceId: validation.value.workspaceId,
      mode: validation.value.mode,
      repoRoot: validation.value.repoRoot,
      findings: normalizedFindings,
    }),
    workspaceId: validation.value.workspaceId,
    mode: validation.value.mode,
    status: auditStatusFor(normalizedFindings),
    findingCount: normalizedFindings.length,
    findings: clone(normalizedFindings),
    createdAt: new Date().toISOString(),
    repoRoot: validation.value.repoRoot,
  };
  return clone(report);
}

function runSelfHealerAudit(input = {}, opts = {}) {
  const source = isPlainObject(input) ? input : {};
  const validation = validateAuditOptions({
    ...opts,
    workspaceId: source.workspaceId ?? opts.workspaceId,
    mode: source.mode ?? opts.mode,
    repoRoot: source.repoRoot ?? opts.repoRoot,
  });
  if (!validation.ok) {
    const error = new Error('Invalid audit options');
    error.validation = validation;
    throw error;
  }
  const checks = Array.isArray(source.checks) ? source.checks : [];
  const findings = checks.map((check) => createFinding(check, { workspaceId: validation.value.workspaceId }));
  return createAuditReport(findings, validation.value);
}

module.exports = {
  AUDIT_MODES,
  AUDIT_STATUSES,
  BLOCKING_FINDING_SEVERITIES,
  createAuditReport,
  createAuditReportId,
  normalizeAuditFindings,
  runSelfHealerAudit,
  validateAuditOptions,
};
