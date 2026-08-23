'use strict';

// Human-readable Turkish sentences for the fixed reason codes emitted by
// lib/mcp-gate-adapter.js's MCP_GATE_REASONS. Free-text reasons (e.g. from
// lib/memory-admission-gate.js, which does not use a fixed enum) fall back
// to the generic template built in explainDecision().
const KNOWN_REASONS = Object.freeze({
  read_only_allow: 'Salt-okunur bir işlem olduğu için izin verildi.',
  mutating_requires_review: 'Veri değiştiren bir işlem olduğu için onay/review gerekiyor.',
  agent_loop_dry_run_only: 'Ajan döngüsü yalnızca kuru-çalıştırma (dry-run) modunda izinli.',
  unknown_tool_blocked: 'Bilinmeyen bir araç çağrıldığı için engellendi.',
  ab1_risk_classifier_blocked: 'AB1 risk sınıflandırıcısı bu işlemi riskli bulup engelledi.',
  ab2_tool_call_gate_blocked: 'AB2 araç çağrısı kapısı (ör. gizli anahtar/parola içeriği) nedeniyle engellendi.',
  ab4_memory_mutation_gate_blocked: 'AB4 bellek mutasyon kapısı nedeniyle engellendi.',
  ab5_automation_safety_gate_blocked: 'AB5 otomasyon güvenlik kapısı nedeniyle engellendi.',
  ab6_sandbox_isolation_gate_blocked: 'AB6 sandbox izolasyon kapısı nedeniyle engellendi.',
  ab8_command_exec_gate_blocked: 'AB8 komut çalıştırma kapısı nedeniyle engellendi (tehlikeli komut).',
  ab8_command_exec_review_required: 'AB8 komut çalıştırma kapısı review gerektiriyor.',
  ab9_egress_review_required: 'AB9 veri sızıntı/egress kapısı review gerektiriyor (hassas veri olabilir).',
  ab9_data_egress_review_required: 'AB9 veri sızıntı/egress kapısı review gerektiriyor (hassas veri olabilir).',
  malformed_input_blocked: 'Girdi hatalı biçimlendirildiği için engellendi.',
  gate_evaluation_error: 'Kapı değerlendirmesi sırasında bir hata oluştu.',
});

const DECISION_LABELS = Object.freeze({
  allow: 'İzin verildi',
  review: "Review'a alındı",
  block: 'Engellendi',
  dry_run_only: 'Yalnızca kuru-çalıştırma (dry-run) izinli',
  disabled: 'Devre dışı',
  quarantine: 'Karantinaya alındı',
});

// #1319: DECISION_LABELS/KNOWN_REASONS are Object.freeze()'d plain objects,
// which does not cut the prototype chain -- Object.freeze only blocks
// mutation. A caller-supplied key like 'constructor' or 'toString' looked
// up with a plain `table[key]` returns the inherited Object.prototype
// member (a function, hence truthy), not undefined, so the `|| fallback`
// pattern never applied and the function's source ended up embedded in the
// human-readable explanation text. Object.hasOwn restricts the lookup to
// the table's own mapped keys.
function lookup(table, key, fallback) {
  return Object.hasOwn(table, key) ? table[key] : fallback;
}

function normalizeDecisionInput(decision) {
  if (!decision || typeof decision !== 'object') return null;
  // Accepts evaluateMcpGate()/evaluateMemoryAdmission() decision objects
  // (`.decision`) and lib/verdict/action-verdict.js canonical envelopes
  // (`.verdict`) -- both carry `.reason`.
  const value = typeof decision.decision === 'string' ? decision.decision
    : typeof decision.verdict === 'string' ? decision.verdict
      : null;
  if (!value) return null;
  return { value, reason: typeof decision.reason === 'string' ? decision.reason : '' };
}

function explainDecision(decision) {
  const normalized = normalizeDecisionInput(decision);
  if (!normalized) {
    return 'Açıklanacak bir karar bulunamadı (decision/verdict alanı eksik).';
  }
  const label = lookup(DECISION_LABELS, normalized.value, normalized.value);
  const knownSentence = lookup(KNOWN_REASONS, normalized.reason, null);
  if (knownSentence) {
    return `${label}: ${knownSentence}`;
  }
  const lowerLabel = label === normalized.value ? label : label.toLocaleLowerCase('tr');
  if (normalized.reason) {
    return `Karar: ${lowerLabel}. Sebep: ${normalized.reason}`;
  }
  return `Karar: ${lowerLabel}.`;
}

module.exports = {
  name: 'decision-explainer',
  version: '0.1.0',
  capabilities: [
    {
      name: 'explain',
      command: 'açıkla',
      description: "Bir gate/verdict kararını insan-okunur Türkçe cümleye çevirir.",
    },
  ],

  run(kernel, input) {
    const decision = input && input.decision ? input.decision : input;
    return {
      ok: true,
      plugin: 'decision-explainer',
      capability: 'explain',
      data: { explanation: explainDecision(decision) },
    };
  },

  afterTask(kernel, data) {
    const gate = data && data.step && data.step.result ? (data.step.result.gate || data.step.result.meta?.gate) : null;
    if (gate) {
      console.log(`[decision-explainer] ${explainDecision(gate)}`);
    }
  },

  explainDecision,
};
