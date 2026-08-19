# HUQAN Agent Action Firewall

**Durum:** Production-wired MVP bileşeni
**Sürüm:** `AAFW-v1.0.0`
**AB5 policy:** `AB5-v0.1.0`

## Amaç

Agent Action Firewall, HUQAN agent’ının bir araç çağrısını veya workflow adımını gerçek bir otomasyon eylemine dönüştürmeden önce tek bir fail-closed karar noktasından geçirir. Firewall, eylem bağlamını AB5 Automation Safety Gate’e taşır; AB5’in `allow`, `review`, `dry_run_only` veya `block` kararını yürütme katmanına aktarır.

Firewall’ın kapsamı yalnızca metin sınıflandırması değildir. **Yürütme öncesi enforcement** sağlar: `block`, `review` ve `dry_run_only` kararlarında executor çağrılmaz. Başarılı kararlar ise yüzeyler arasında taşınabilir bir audit metadata’sı üretir.

> **Güvenlik ilkesi:** Firewall karar veremiyor, input malformed veya evaluator exception veriyorsa agent action çalışmaz.

## Karar sözleşmesi

| Karar | Executor | Kullanıcıya yansıma | Tipik örnek |
|---|---:|---|---|
| `allow` | Çalışır | `done` / başarılı sonuç | Salt-okuma `ask`, `verify`, `reason` |
| `review` | Çalışmaz | `review`, `AGENT_ACTION_REVIEW_REQUIRED` | Bilinmeyen otomasyon operasyonu |
| `dry_run_only` | Çalışmaz; preview mümkün | `review` veya dry-run sonucu | Merge/deploy preview |
| `block` | Çalışmaz | `blocked`, `AGENT_ACTION_BLOCKED` | `force_push`, CI bypass, secret persistence |

`allow` yalnızca aşağıdaki dar durumlarda firewall tarafından doğrudan verilir: salt-okuma agent araçları, normal `learn` girdileri ve AB4’e devredilen sıradan memory write akışları. Yapılandırılmış action alanı veya otomasyon sinyali geldiğinde karar AB5’e devredilir.

## Üretim yürütme yüzeyleri

### Classic AgentV3 / CLI

`agent.js` içindeki gerçek step executor’ı, kernel tool çağrısından önce `evaluateAgentActionFirewall()` çağırır. Firewall kararı `block`, `review` veya `dry_run_only` ise `kernel.learn()`, `kernel.ask()` veya diğer executor dalları çalıştırılmaz. Karar `afterGateDecision` telemetry yüzeyine de gönderilir.

CLI varsayılan olarak aynı classic runtime factory’sini kullandığı için bu enforcement CLI agent-run akışını da kapsar. CLI’nin mevcut tool-policy gate’i firewall’dan sonra çalışmaya devam eder; iki karar birbirini zayıflatmaz.

### Workflow runtime / HTTP

`workflow-agent.js` içindeki `ToolRegistry.runTool()` aynı firewall kararını araç çalıştırılmadan önce üretir. HTTP `/api/v2/agent/run` ve `/api/v2/agent/plan` yüzeyleri workflow runtime’ı üzerinden çalıştığında sonuçta şu kanıt alanları korunur:

- `step.status`: `done`, `review`, `blocked` veya `error`
- `step.error.code`: örneğin `AGENT_ACTION_BLOCKED`
- `step.actionFirewall`: AB5 kararının güvenli metadata’sı
- `step.trace[].firewallDecision` ve `step.trace[].firewallReason`

### MCP / `huqan.agent`

MCP gate adapter’da `huqan.agent` artık AB5 gate listesine dahildir. Hem açık action alanları hem de yalnızca `goal` metni AB5 input’una taşınır. Örneğin `goal: "force push origin/main immediately"` açık `action` alanı olmadan da `block` sonucuna gider. Normal agent goal’ı, agent-loop politikasının mevcut `dry_run_only` kararını korur ve AB5 bulgusunu response findings içinde taşır.

`huqan.agent_resume` ayrı bir executor değildir; operator-authenticated continuation tekrar `agent.run()` çağırır. Bu nedenle classic veya workflow runtime’daki ana yürütme seam’i resume akışını da kapsar.

## Audit ve veri minimizasyonu

Firewall ham agent input’unu audit metadata’sına yazmaz. Metadata yalnızca aşağıdaki bounded alanları taşır:

- `surface`, `tool`, `action`
- `workspaceId`
- `inputKeys`
- `actionId`: yüzey, araç, action, workspace ve target’ın tek yönlü SHA-256 parmak izi
- `firewallVersion`, `policyVersion`
- AB5 kararı, sebebi, risk kategorileri ve findings

Secret veya PII içeren çağrılar AB5’te engellendiğinde findings ham eşleşen değeri echo etmez. Bu özellik, enforcement kanıtı üretirken token, URL credential veya kişisel veriyi log’a taşımama hedefiyle tasarlanmıştır.

## Örnekler

### Güvenli salt-okuma çağrısı

```js
const { evaluateAgentActionFirewall } = require('./lib/agent-action-firewall');

const decision = evaluateAgentActionFirewall({
  surface: 'agent',
  tool: 'ask',
  action: 'ask',
  input: 'What is the current policy?',
  context: { workspaceId: 'default' },
});

// decision.decision === 'allow'
```

### Engellenen yüksek riskli action

```js
const decision = evaluateAgentActionFirewall({
  surface: 'workflow',
  tool: 'github',
  action: 'force_push',
  input: { action: 'force_push', target: 'origin/main' },
  context: { workspaceId: 'repo-main' },
});

// decision.decision === 'block'
// executor çağrılmamalıdır.
```

## Yayın öncesi checklist

- [x] AB5 evaluator agent action context’iyle production executor’dan önce çağrılıyor.
- [x] Classic AgentV3 ve CLI yürütme seam’i bağlı.
- [x] Workflow runtime ve HTTP agent-run seam’i bağlı.
- [x] MCP `huqan.agent` action/goal içeriği AB5’e bağlı.
- [x] MCP `huqan.agent_resume` ana `agent.run()` seam’ine geri dönüyor.
- [x] `block`, `review`, `dry_run_only` durumlarında executor çağrılmıyor.
- [x] Fail-closed evaluator exception ve malformed input testleri mevcut.
- [x] Audit metadata ham input yerine bounded keys ve fingerprint kullanıyor.
- [x] MCP response findings ve workflow trace AB5 kararını taşıyor.
- [ ] Gerçek dış sistem connector’ları için her connector’a özgü action vocabulary genişletilmeli.
- [ ] Release öncesi hedef CI ortamında tam test ve security workflow sonuçları alınmalı.

## Bilinen sınırlar

Firewall, dış sistemlerdeki gerçek yetkilendirmelerin yerine geçmez. GitHub token scope, deploy platform permission, branch protection veya cloud IAM ayrıca enforce edilmelidir. Firewall’ın görevi HUQAN agent’ının kendi karar ve yürütme zincirinde yüksek riskli action’ları erken durdurmak, review/dry-run yoluna almak ve kanıt üretmektir.

Yeni bir action connector’ı eklenirken action adı, hedef, branch/baseBranch, approval ve preview semantiği açıkça AB5 input’una taşınmalı; connector executor’ı firewall kararını görmeden çalışmamalıdır.
