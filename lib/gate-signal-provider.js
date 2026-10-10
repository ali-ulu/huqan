'use strict';

// The gate signal provider: the seam through which a domain plugin contributes
// bounded *evidence* to a core gate decision, without contributing the decision
// itself.
//
// docs/core-plugin-boundary-contract.md puts the action gate in core and domain
// interpretation in plugins. So a plugin may not return a verdict for a tool
// call; it may only report a *signal* -- a named, scored fact about the call.
// This module collects those signals, folds in any active error-prevention rule
// that matches the same action, and hands the gate one most-restrictive verdict
// to merge with its own. The gate stays the decider: it merges this verdict, it
// never adopts it as final.
//
// Two ways in, one shape out:
//   - plugin signals, via the `beforeGateDecision` hook (a plugin reports what
//     its domain sees, e.g. AURA's social-engineering vectors);
//   - active error-prevention rules, so a rule learned from a past blind spot
//     hardens the live gate rather than only the SDK's preflight().
//
// Fail closed: a provider that cannot run is not evidence of safety, so its
// verdict floors at `review`, never `allow`.

const { buildActionFingerprint, normalizeAction } = require('./error-prevention');
const { matchesRule } = require('./error-prevention/decision');

const SIGNAL_DECISIONS = Object.freeze(['allow', 'review', 'block']);
const RANK = Object.freeze({ allow: 0, review: 1, block: 2 });

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Unknown verdicts rank as `block`: a value this module does not recognise must
// not be read as permission.
function rankOf(verdict) {
  return Object.hasOwn(RANK, verdict) ? RANK[verdict] : RANK.block;
}

function mostRestrictive(current, requested) {
  return rankOf(requested) > rankOf(current) ? requested : current;
}

function normalizeSignal(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const id = cleanString(signal.id);
  if (!id) return null;
  const decision = SIGNAL_DECISIONS.includes(signal.decision) ? signal.decision : 'review';
  const rawScore = Number(signal.riskScore);
  const riskScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  return { id, decision, riskScore, reason: cleanString(signal.reason) };
}

function workspaceFromInput(input) {
  const metadata = input && typeof input.metadata === 'object' && input.metadata ? input.metadata : {};
  return cleanString(metadata.workspaceId);
}

// The tool name is the stable operation axis a gate sees; `huqan.ask` is the
// `ask` operation. An explicit `args.operation` wins when a caller sets one.
function operationFromTool(tool) {
  const name = cleanString(tool);
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}

function ruleVerdict(enforcement) {
  if (enforcement === 'block') return 'block';
  if (enforcement === 'require_verify') return 'review';
  return 'allow';
}

function buildProviderVerdict(input, signals, rules, fallbackWorkspaceId) {
  const tool = cleanString(input && input.tool);
  const args = input && typeof input.args === 'object' && input.args ? input.args : {};
  const workspaceId = workspaceFromInput(input) || fallbackWorkspaceId || 'default';
  const operation = cleanString(args.operation || args.action) || operationFromTool(tool);
  const action = {
    ...normalizeAction({ tool, operation, workspaceId }),
    actionFingerprint: buildActionFingerprint({ tool, operation, workspaceId }),
  };

  let decision = 'allow';
  let reason = '';
  const findings = [];

  for (const raw of signals) {
    const signal = normalizeSignal(raw);
    if (!signal) continue;
    const before = decision;
    decision = mostRestrictive(decision, signal.decision);
    // A signal that actually raised the verdict owns the reason, so the gate
    // reports *why* (e.g. `aura_signals:recon:targeted`) rather than a generic
    // provider message. A rule that raises it later keeps its own reason.
    if (decision !== before) reason = signal.reason || `signal:${signal.id}`;
    findings.push({ gate: 'SIGNAL', signal: signal.id, decision: signal.decision, risk: { score: signal.riskScore } });
  }

  for (const rule of rules) {
    if (!rule || !matchesRule(rule, action)) continue;
    const verdict = ruleVerdict(rule.enforcement);
    const before = decision;
    decision = mostRestrictive(decision, verdict);
    if (decision !== before) reason = `rule:${rule.ruleId || ''}`;
    findings.push({ gate: 'RULE', ruleId: rule.ruleId || '', decision: verdict });
  }

  return { decision, reason: reason || (decision === 'allow' ? 'no_signal' : 'signal'), findings };
}

/**
 * Build a signal provider from explicit collaborators. The provider is a pure
 * function of the gate input; the collaborators supply where signals and rules
 * come from, so the seam can be driven by a kernel in production or by a test
 * double in a unit test without changing the provider.
 */
function createGateSignalProvider(collaborators = {}) {
  const emitSignals = typeof collaborators.emitSignals === 'function'
    ? collaborators.emitSignals
    : () => ({ signals: [], failed: false });
  const listRules = typeof collaborators.listRules === 'function' ? collaborators.listRules : () => [];
  const fallbackWorkspaceId = cleanString(collaborators.workspaceId) || 'default';

  return function provide(input = {}) {
    let collected;
    try {
      collected = emitSignals(input) || {};
    } catch (err) {
      return {
        decision: 'review',
        reason: 'signal_provider_error',
        findings: [{ gate: 'SIGNAL', decision: 'review', error: err && err.message }],
      };
    }
    const signals = Array.isArray(collected.signals) ? collected.signals : [];
    let rules = [];
    try {
      rules = listRules(input) || [];
    } catch (_) {
      rules = [];
    }
    const verdict = buildProviderVerdict(input, signals, rules, fallbackWorkspaceId);
    if (collected.failed === true) verdict.decision = mostRestrictive(verdict.decision, 'review');
    return verdict;
  };
}

const kernelProviders = new WeakMap();

// The error-prevention engine needs a full memory store. A kernel that does not
// have one (a test double, a read-only shell) must not make the gate throw: the
// gate fails closed on a *provider error*, but a missing rule source is simply
// no rules, which is not an error.
function canPrevent(kernel) {
  const memory = kernel && kernel.memory;
  return Boolean(memory
    && typeof memory.store === 'function'
    && typeof memory.list === 'function'
    && typeof memory.get === 'function'
    && typeof memory.supersede === 'function');
}

/**
 * A signal provider backed by a live kernel: signals come from every loaded
 * plugin's `beforeGateDecision` hook, rules from the kernel's own
 * error-prevention store. Cached per kernel, since it is rebuilt on every gate
 * call otherwise.
 */
function gateSignalProviderForKernel(kernel, options = {}) {
  if (!kernel || typeof kernel !== 'object') return createGateSignalProvider({});
  const cached = kernelProviders.get(kernel);
  if (cached) return cached;

  const fallbackWorkspaceId = cleanString(options.workspaceId) || 'default';

  let prevention = null;
  let preventionReady = false;
  function preventionEngine() {
    if (preventionReady) return prevention;
    preventionReady = true;
    if (!canPrevent(kernel)) return null;
    try {
      const { createErrorPrevention } = require('./error-prevention');
      prevention = createErrorPrevention(kernel.memory);
    } catch (_) {
      prevention = null;
    }
    return prevention;
  }

  const provider = createGateSignalProvider({
    workspaceId: fallbackWorkspaceId,
    emitSignals(input) {
      // Every loaded plugin may report a bounded signal about this call through
      // its `gateSignal` method (plugins/aura-risk.js is the reference). A
      // plugin that throws, or returns a thenable the synchronous seam cannot
      // await, is not evidence of safety: it floors the verdict at `review`.
      const plugins = kernel.plugins;
      const loaded = plugins && Array.isArray(plugins.plugins) ? plugins.plugins : [];
      const signals = [];
      let failed = false;
      for (const plugin of loaded) {
        if (typeof plugin.gateSignal !== 'function') continue;
        try {
          const signal = plugin.gateSignal(kernel, structuredClone(input));
          if (signal && typeof signal.then === 'function') { failed = true; continue; }
          if (!signal || typeof signal !== 'object') continue;
          signals.push({
            id: signal.id || `${plugin.name}:signal`,
            decision: signal.decision,
            riskScore: signal.riskScore,
            reason: signal.reason,
          });
        } catch (_) {
          failed = true;
        }
      }
      return { signals, failed };
    },
    listRules(input) {
      const engine = preventionEngine();
      if (!engine) return [];
      const workspaceId = workspaceFromInput(input) || fallbackWorkspaceId;
      try {
        const listed = engine.listRules({ workspaceId, status: 'active' });
        return listed && listed.ok ? listed.rules : [];
      } catch (_) {
        return [];
      }
    },
  });

  kernelProviders.set(kernel, provider);
  return provider;
}

module.exports = {
  SIGNAL_DECISIONS,
  buildProviderVerdict,
  createGateSignalProvider,
  gateSignalProviderForKernel,
  mostRestrictive,
  normalizeSignal,
  operationFromTool,
  ruleVerdict,
};
