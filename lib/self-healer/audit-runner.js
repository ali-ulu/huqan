'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  createFinding,
  createFindingId,
  normalizeFinding,
  validateFinding,
} = require('./finding-schema');

const AUDIT_MODES = Object.freeze([
  'audit_only',
]);

const AUDIT_STATUSES = Object.freeze([
  'ready',
  'blocked',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeWorkspaceId(workspaceId) {
  return String(workspaceId || 'default').trim() || 'default';
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
  if (options.outputPath && !options.allowOutput) {
    errors.push({ field: 'outputPath', code: 'VALIDATION_ERROR', message: 'outputPath is disabled in audit_only mode' });
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
    status: normalizedFindings.length > 0 ? 'ready' : 'ready',
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
  createAuditReport,
  createAuditReportId,
  normalizeAuditFindings,
  runSelfHealerAudit,
  validateAuditOptions,
};
