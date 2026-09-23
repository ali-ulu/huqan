const crypto = require('crypto');
const { handleIngest, buildIngestApprovalSnapshot, sha256 } = require('../ingest');
const HuqanStorage = require('../../storage');
const { decideIngestApproval } = require('../workbench/ingest-approval-action');
const { createHttpIngestOversightCase } = require('../http-human-oversight-adapter');
const { createHttpIngestApprovalAuditWriter } = require('./ingest-approval-audit-writer');
const { createTrustEvidenceLedger } = require('../trust-evidence-ledger');
const { newIngestApprovalId, publicIngestApproval } = require('../server-response-helpers');

function createIngestApprovalRuntime({ kernel, readEnvironment, ensureRuntime }) {
  let approvalStore = null;
  let humanOversightConfig = null;
  let agentIdentityConfig = null;
  const workerId = `http-ingest-${crypto.randomUUID()}`;
  const leaseMs = Math.max(
    30_000,
    Math.min(900_000, Number(readEnvironment('INGEST_APPROVAL_LEASE_MS')) || 120_000),
  );
  const trustEvidenceLedger = createTrustEvidenceLedger({ graph: kernel.graph });

  function recover(store = approvalStore) {
    if (!store || typeof store.recoverExpiredToolApprovals !== 'function') return [];
    return store.recoverExpiredToolApprovals({
      tool: 'http.ingest',
      reason: 'execution_outcome_unknown:lease_expired',
    });
  }

  function getStore() {
    if (approvalStore) return approvalStore;
    approvalStore = new HuqanStorage({ kernel });
    recover(approvalStore);
    return approvalStore;
  }

  function configureHumanOversight(config = null) {
    if (config === null || config === undefined) {
      humanOversightConfig = null;
      return null;
    }
    const runtime = config.runtime || config.humanOversightApprovalRuntime;
    if (!runtime || typeof runtime.createReviewCase !== 'function'
        || typeof runtime.getReviewCase !== 'function'
        || typeof runtime.decide !== 'function'
        || typeof runtime.executeApproved !== 'function') {
      throw new TypeError('human oversight approval runtime is required');
    }
    humanOversightConfig = Object.freeze({ ...config, runtime });
    return humanOversightConfig;
  }

  function configureAgentIdentity(config = null) {
    if (config === null || config === undefined) {
      agentIdentityConfig = null;
      return null;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || !config.action || typeof config.action !== 'object' || Array.isArray(config.action)) {
      throw new TypeError('agent identity runtime config with action is required');
    }
    agentIdentityConfig = Object.freeze({
      ...config,
      action: Object.freeze({ ...config.action }),
    });
    return agentIdentityConfig;
  }

  function getApprovalRuntimeConfig() {
    if (!humanOversightConfig && agentIdentityConfig === null) return null;
    return Object.freeze({
      ...(humanOversightConfig || {}),
      ...(agentIdentityConfig !== null ? { agentIdentityRuntime: agentIdentityConfig } : {}),
    });
  }

  const recordAudit = createHttpIngestApprovalAuditWriter({
    graph: kernel.graph,
    getIdentityConfig: () => agentIdentityConfig,
    hashResult: sha256,
    ledger: trustEvidenceLedger,
  });

  async function submit(data) {
    const snapshot = buildIngestApprovalSnapshot(data);
    if (!snapshot.ok) {
      return {
        status: snapshot.code === 'INGEST_WORKSPACE_UNSUPPORTED' ? 400 : 409,
        error: {
          code: snapshot.code || 'INGEST_SNAPSHOT_REQUIRED',
          message: snapshot.error || 'Ingest cannot be queued safely.',
        },
      };
    }
    try {
      const store = getStore();
      const approvalKey = `http.ingest.${snapshot.sourceType}.${snapshot.idempotencyKey}.${snapshot.snapshotHash}`;
      const saved = store.saveToolApprovalIfAbsent({
        id: newIngestApprovalId(),
        approvalKey,
        tool: 'http.ingest',
        input: JSON.stringify(snapshot.payload),
        status: 'pending',
        decision: 'review',
        reason: 'http_ingest_requires_review',
        context: {
          source: 'http-ingest',
          snapshot,
          ...(humanOversightConfig ? { oversightRequired: true } : {}),
        },
        policy: { action: 'ingest', approval: 'review', snapshotIntegrity: 'sha256' },
      });
      const oversightCase = humanOversightConfig
        ? createHttpIngestOversightCase({
          approval: saved.approval,
          humanOversight: getApprovalRuntimeConfig(),
        })
        : { enabled: false, ok: true };
      if (oversightCase.enabled && !oversightCase.ok) {
        return {
          status: 503,
          error: {
            code: 'REVIEW_CASE_NOT_PERSISTED',
            message: 'Human Oversight review case was not durably recorded; ingest remains unexecuted.',
          },
        };
      }
      return {
        status: saved.approval.status === 'pending' ? 202 : 200,
        json: {
          ok: true,
          status: saved.approval.status,
          idempotent: !saved.inserted,
          approval: publicIngestApproval(saved.approval),
          ...(oversightCase.enabled ? { oversight: oversightCase.summary } : {}),
        },
      };
    } catch (_) {
      return {
        status: 503,
        error: {
          code: 'APPROVAL_STORE_UNAVAILABLE',
          message: 'Persistent ingest approval store is unavailable.',
        },
      };
    }
  }

  function decide({ approvalId, workspaceId, decision, reason }) {
    return decideIngestApproval({
      store: getStore(),
      kernel,
      approvalId,
      workspaceId,
      decision,
      reason,
      humanOversight: getApprovalRuntimeConfig(),
      handleIngest,
      ensureRuntime,
      recordAudit,
      toPublicApproval: publicIngestApproval,
      workerId,
      leaseMs,
    });
  }

  function close() {
    if (!approvalStore || typeof approvalStore.close !== 'function') {
      approvalStore = null;
      return;
    }
    try { approvalStore.close(); } catch (_) {}
    approvalStore = null;
  }

  return Object.freeze({
    getStore,
    recover,
    configureHumanOversight,
    configureAgentIdentity,
    getApprovalRuntimeConfig,
    submit,
    decide,
    close,
    workerId,
    leaseMs,
  });
}

module.exports = { createIngestApprovalRuntime };
