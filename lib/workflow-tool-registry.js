'use strict';

// The workflow tool registry: tool records, policy and action-firewall gating,
// and the normalised tool output. Moved out of workflow-agent.js (#2132) unchanged.
const { INTERNAL_TOOLS, evaluateToolPolicy } = require('../toolPolicy');
const { RECEIVER_OWNED_INTERNAL_TOOL } = require('./workflow-tool-registration');
const { evaluateAgentActionFirewall } = require('./agent-action-firewall');
const { firewallError } = require('./agent-action-decisions');
const { createReceiverOwnedInternalActionRequest } = require('./agent-action-step-enforcement');
const { isExternalReviewApproved } = require('./workflow-review-approval');
const { cloneValue, normalizeName, normalizeConfidence, normalizeEvidence, normalizeError, normalizePositiveInteger } = require('./workflow-values');
function normalizeToolOutput(result, tool, policy, meta = {}) {

  const hasEnvelope = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok');
  const envelope = hasEnvelope ? result : { ok: true, data: result };
  const ok = Boolean(envelope.ok);
  const data = envelope.data !== undefined ? cloneValue(envelope.data) : cloneValue(envelope);
  const error = ok ? null : normalizeError(envelope.error, 'TOOL_ERROR', 'Tool execution failed.');
  const evidence = normalizeEvidence(envelope.evidence || data?.evidence || []);
  const confidenceSource = envelope.confidence ?? envelope.meta?.confidence ?? data?.confidence ?? meta.confidence;
  const confidence = normalizeConfidence(confidenceSource, ok ? 0.55 : 0);

  const firewallReviewApproved = meta.firewall
    && meta.firewall.decision === 'review'
    && isExternalReviewApproved(meta.approval);

  return {
    ok,
    tool: tool.name,
    status: meta.firewall && (meta.firewall.decision === 'block' || meta.firewall.decision === 'dry_run_only')
      ? 'blocked'
      : meta.firewall && meta.firewall.decision !== 'allow' && !firewallReviewApproved
        ? 'review'
        : policy && policy.blocked
          ? 'blocked'
          : policy && policy.review && !isExternalReviewApproved(meta.approval)
            ? 'review'
            : ok
              ? 'done'
              : 'error',
    inputSchema: cloneValue(tool.inputSchema),
    description: tool.description,
    data,
    output: data,
    evidence,
    confidence,
    error,
    meta: {
      tool: {
        name: tool.name,
        description: tool.description,
        inputSchema: cloneValue(tool.inputSchema),
        kind: tool.kind,
        cost: tool.cost,
      },
      policy: cloneValue(policy),
      firewall: cloneValue(meta.firewall || null),
    },
  };
}

class ToolRegistry {
  constructor(opts = {}) {
    this._tools = [];
    this._order = 0;
    this._internalTools = new Set([
      ...Array.from(INTERNAL_TOOLS || []),
    ].map(normalizeName));
  }

  _cloneTool(tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneValue(tool.inputSchema),
      kind: tool.kind,
      cost: tool.cost,
      order: tool.order,
      tags: Array.isArray(tool.tags) ? [...tool.tags] : [],
      registeredAt: tool.registeredAt,
    };
  }

  registerTool(tool = {}) {
    const name = normalizeName(tool.name);
    if (!name) {
      throw new Error('Tool name is required.');
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Tool ${name} must define run(context, input).`);
    }

    const declaredKind = tool.kind;
    if (declaredKind !== undefined && declaredKind !== 'internal' && declaredKind !== 'external') {
      throw new Error(`Tool ${name} must declare kind as "internal" or "external".`);
    }
    const receiverOwnedInternal = tool[RECEIVER_OWNED_INTERNAL_TOOL] === true;
    const internalAuthority = receiverOwnedInternal
      || (INTERNAL_TOOLS.has(name) && declaredKind !== 'external');
    const kind = internalAuthority ? 'internal' : 'external';

    const record = {
      name,
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema ? cloneValue(tool.inputSchema) : { type: 'object' },
      run: tool.run,
      kind,
      internalAuthority,
      cost: normalizePositiveInteger(tool.cost, 1),
      order: Number.isFinite(tool.order) ? Number(tool.order) : this._order,
      tags: Array.isArray(tool.tags) ? [...tool.tags] : [],
      registeredAt: this._order,
    };
    this._order += 1;

    const existingIndex = this._tools.findIndex(entry => entry.name === name);
    if (existingIndex >= 0) {
      record.order = this._tools[existingIndex].order;
      record.registeredAt = this._tools[existingIndex].registeredAt;
      this._tools[existingIndex] = record;
    } else {
      this._tools.push(record);
    }

    return this._cloneTool(record);
  }

  listTools() {
    return [...this._tools]
      .sort((a, b) => a.order - b.order)
      .map(tool => this._cloneTool(tool));
  }

  getTool(name) {
    const normalized = normalizeName(name);
    const tool = this._tools.find(entry => entry.name === normalized);
    return tool ? this._cloneTool(tool) : null;
  }

  _getToolRecord(name) {
    const normalized = normalizeName(name);
    return this._tools.find(entry => entry.name === normalized) || null;
  }

  _policyInternalTools() {
    const names = new Set([...this._internalTools]);
    for (const tool of this._tools) {
      if (tool.internalAuthority === true) {
        names.add(tool.name);
      }
    }
    return names;
  }

  async runTool(name, input, context = {}) {
    const tool = this._getToolRecord(name);
    if (!tool) {
      const policy = evaluateToolPolicy({
        tool: name,
        input,
        context,
        internalTools: this._policyInternalTools(),
      });
      return {
        ok: false,
        tool: normalizeName(name),
        status: 'blocked',
        inputSchema: null,
        description: '',
        data: null,
        output: null,
        evidence: [],
        confidence: 0,
        error: normalizeError({ code: 'UNKNOWN_TOOL', message: `Unknown tool: ${String(name)}` }, 'UNKNOWN_TOOL', `Unknown tool: ${String(name)}`),
        meta: {
          tool: null,
          policy,
        },
      };
    }

    const policy = evaluateToolPolicy({
      tool: tool.name,
      input,
      context,
      internalTools: this._policyInternalTools(),
    });
    const approved = isExternalReviewApproved(context.approval);
    const firewallApproval = approved
      ? {
          explicit: true,
          approved: true,
          reviewed: true,
          notes: context.approval.reason,
          reviewedBy: 'workflow-operator',
        }
      : context.agentActionApproval;
    const firewallRequest = {
      surface: 'workflow',
      tool: tool.name,
      action: context.action || context.step?.action || context.operationType || tool.name,
      input,
      context: {
        ...context,
        workspaceId: context.workspaceId || context.plan?.workspaceId || 'default',
        actor: context.actor || 'workflow-agent',
      },
      approval: firewallApproval,
      preview: context.preview === true,
      dryRun: context.dryRun === true,
    };
    const firewall = evaluateAgentActionFirewall(tool.internalAuthority === true
      ? createReceiverOwnedInternalActionRequest(firewallRequest)
      : firewallRequest);

    // A review is an execution gate, not a post-execution label. The same
    // unforgeable operator approval that satisfies external review may release
    // a firewall review for either tool kind.
    if (firewall.decision === 'block' || firewall.decision === 'dry_run_only'
      || (tool.kind === 'internal' && firewall.decision === 'review' && !approved)) {
      return normalizeToolOutput({
        ok: false,
        error: {
          code: firewallError(firewall.decision),
          message: firewall.reason || 'Agent action was stopped by the action firewall.',
        },
        evidence: [],
        meta: { policy, firewall },
      }, tool, policy, { ...context, firewall });
    }

    if (tool.kind === 'external' && policy.blocked) {
      return normalizeToolOutput({
        ok: false,
        error: {
          code: 'TOOL_BLOCKED',
          message: policy.reasons[0] || `Tool ${tool.name} is blocked.`,
        },
        evidence: [],
        meta: { policy, firewall },
      }, tool, policy, { ...context, firewall });
    }

    if (tool.kind === 'external' && policy.review && !approved) {
      return normalizeToolOutput({
        ok: false,
        error: {
          code: 'TOOL_REVIEW_REQUIRED',
          message: policy.reasons[0] || `Tool ${tool.name} requires review.`,
        },
        evidence: [],
        meta: { policy, firewall },
      }, tool, policy, { ...context, firewall });
    }

    try {
      const result = await Promise.resolve(tool.run(cloneValue(context), cloneValue(input)));
      return normalizeToolOutput(result, tool, policy, { ...context, firewall });
    } catch (error) {
      return normalizeToolOutput({
        ok: false,
        error: normalizeError(error, 'TOOL_ERROR', `Tool ${tool.name} threw an error.`),
        evidence: [],
        meta: { policy, firewall },
      }, tool, policy, { ...context, firewall });
    }
  }
}

module.exports = { ToolRegistry, normalizeToolOutput };
