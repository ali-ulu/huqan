# Observability Telemetry Client

HUQAN’ın `createObservabilityTelemetryClient` yüzeyi, aynı Node.js sürecinde çalışan AgentV3 veya başka bir agent framework’ünün lifecycle olaylarını mevcut observability service’e bağlayan **local-first ve framework-neutral** bir seam’dir. Client yeni bir telemetry deposu veya yeni bir approval/policy authority oluşturmaz; verilen service’in mevcut `recordRunStart`, `recordStep`, `recordGateDecision` ve `recordRunFinish` metodlarını çağırır.

> Bu client, hosted telemetry ingestion, public multi-tenant authority veya üçüncü taraf interoperability kanıtı değildir. Oluşturulması network çağrısı başlatmaz ve varsayılan server runtime’ına dış endpoint eklemez.

## Başlangıç

```js
const {
  createObservabilityTelemetryClient,
} = require('huqan');

const telemetry = createObservabilityTelemetryClient({
  service: kernel.observability,
  workspaceId: 'workspace-a',
  agentId: 'agent-a',
  runtime: 'agent-v3',
});

telemetry.startRun({
  runId: 'run-a',
  traceId: 'trace-a',
  goal: 'Verify a bounded local claim',
});

telemetry.recordStep({
  runId: 'run-a',
  traceId: 'trace-a',
  status: 'done',
  tool: 'memory.read',
  usage: { inputTokens: 12, outputTokens: 20 },
  payload: { stepId: 'step-a', phase: 'execute' },
});

telemetry.finishRun({
  runId: 'run-a',
  traceId: 'trace-a',
  status: 'completed',
  stepCount: 1,
  successfulSteps: 1,
});
```

`examples/observability-client.js` dosyası aynı sözleşmenin AgentV3 `beforeAgentRun`, `afterTask` ve `afterAgentRun` callback’lerine bağlanmış halini içerir. Örnek, step sonucu içindeki yalnız usage alanını ve bounded step/policy metadata’sını geçirir.

## Güvenlik ve kapsam

Client oluşturulurken `workspaceId` zorunludur ve client yaşamı boyunca sabit kalır. Method input’unda ayrıca verilen `workspaceId` bu sabit scope ile birebir eşleşmiyorsa çağrı daha service’e ulaşmadan reddedilir. `runId` zorunludur; `traceId` verilmezse run kimliğine bağlanır. Böylece çağrılar başka bir workspace’e sessizce yönlendirilmez.

`goal` service’e plaintext olarak geçirilmez. Client, UTF-8 SHA-256 `goalDigest` ve uzunluk bilgisini üretir. İstemci önceden digest biliyorsa `goalDigest` ile birlikte en fazla bounded `goalLength` gönderilebilir. Step ve gate payload’ları canonical `safePayload` helper’ından geçer; `prompt`, `goal`, `input`, `output`, `secret`, `credential`, `authorization` veya hassas anahtar kelimesi taşıyan alanlar kayda girmez. Response modelleri de redacted observability API sözleşmesindeki hassas alanları yayınlamaz.

Client’in event vocabulary’si kasıtlı olarak dört lifecycle türüyle sınırlıdır: `run_started`, `step_finished`, `gate_decision` ve `run_finished`. Queue ve alert lifecycle event’leri service/runtime authority’sine aittir; client bunları taklit ederek queue veya alarm state’i değiştirmez.

## Migration: doğrudan service/lifecycle çağrısından client’e

Mevcut bir AgentV3 entegrasyonunda doğrudan şu tür çağrılar varsa:

```js
service.recordLifecycle('beforeAgentRun', state);
service.recordLifecycle('afterTask', { state, step });
service.recordLifecycle('afterAgentRun', state);
```

bunları tek bir sabit workspace scope’u olan client adapter’a taşıyın:

```js
const { createAgentV3ObservabilityHooks } = require('./examples/observability-client');

const hooks = createAgentV3ObservabilityHooks({
  service,
  workspaceId,
  agentId,
  runtime: 'agent-v3',
});

hooks.beforeAgentRun(state);
hooks.afterTask({ state, step });
hooks.afterAgentRun(state);
```

Bu migration örneği repository checkout içindeki `examples/observability-client.js` artifact’ını kullanır; bu dosya npm runtime entry point’i değildir. Paket tüketicisi aynı adapter kodunu kendi source tree’sine taşımalı veya doğrudan `createObservabilityTelemetryClient` API’sini kullanmalıdır.

Bu migration aynı event persistence ve alert evaluation service’ini kullanır. Yeni bir database, global state, approval bypass veya external network transport eklemez. Existing runtime’ın kendi `kernel.observability.recordLifecycle` wiring’i ayrı tutulabilir; aynı lifecycle’ı iki kez bağlayan adapter kurulursa duplicate event üretilebileceğinden tek bir owner seçilmelidir.

## Hata yönetimi

Client input hatalarında senkron `TypeError` ve sabit `error.code` değerleri üretir. Özellikle eksik workspace `OBSERVABILITY_CLIENT_WORKSPACE_REQUIRED`, scope uyuşmazlığı `OBSERVABILITY_CLIENT_WORKSPACE_SCOPE_MISMATCH`, eksik run `OBSERVABILITY_CLIENT_RUN_ID_REQUIRED`, geçersiz digest `OBSERVABILITY_CLIENT_GOAL_DIGEST_INVALID` ve zorunlu status/decision hataları ayrı kodlarla ayırt edilir.

Service hata verirse client hatayı sessizce başarıya çevirmez, otomatik retry yapmaz ve policy/approval sonucunu değiştirmez; service error çağırana propagate edilir. Host uygulama retry uygulayacaksa bunu kendi bounded ve idempotent çalışma modelinde, aynı `workspaceId`, `runId` ve `traceId` ile açıkça tasarlamalıdır. Client’in kendisi telemetry kaydını “best effort başarılı” ilan etmez.

Aşağıdaki pattern, telemetry hatasını ana AgentV3 policy akışından ayırırken başarısız telemetry’yi gizlememek için kullanılabilir:

```js
try {
  telemetry.recordStep(stepTelemetry);
} catch (error) {
  logger.error({
    event: 'observability_client_failure',
    code: error.code || 'OBSERVABILITY_CLIENT_FAILURE',
    workspaceId: telemetry.workspaceId,
    runId: stepTelemetry.runId,
    traceId: stepTelemetry.traceId || stepTelemetry.runId,
  });
  throw error;
}
```

Log kaydına goal, prompt, input, output, secret veya credential eklenmemelidir. Bu örnek, agent policy kararını onaylama veya reddetme kuralı değildir; yalnızca host’un error boundary’sini göstermektedir.

## Kanıt ve sınırlar

`test/observability-client.test.js`, dört lifecycle event’inin gerçek observability service üzerinden yazıldığını; workspace/run/trace kimliklerinin korunduğunu; goal digest ve redacted payload davranışını; invalid scope/identity input’larının fail-closed reddedildiğini; service hatalarının propagate edildiğini doğrular. Bu test, hosted deployment, bağımsız kullanıcı çalışması, soak performansı veya üçüncü taraf client interoperability kanıtı değildir.
