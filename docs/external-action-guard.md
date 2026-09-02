# HUQAN external action guard

**Durum:** v1, production entry point (`huqan-gate`)

Bu guard HUQAN'ın kendi ajanı için değil, HUQAN dışında çalışan ajanların araç
çağrıları içindir. Politika çekirdeği ajan markası bilmez. Bir istemci
uyarlayıcısı yalnızca kendi hook event'ini ortak zarfa çevirir ve HUQAN kararını
istemcinin çalıştırma-öncesi durdurma mekanizmasına geri yansıtır.

## Ortak zarf

Yeni veya adı önceden bilinmeyen bir ajan şu sözleşmeye çevrilebildiği anda aynı
çekirdeği kullanır:

```json
{
  "schemaVersion": "huqan.external-action.v1",
  "invocationId": "tool-call-123",
  "agentName": "future-agent-2035",
  "agentVersion": "1.0.0",
  "sessionId": "session-9",
  "turnId": "turn-4",
  "toolName": "shell",
  "kind": "shell",
  "args": { "command": "git status" },
  "cwd": "C:/work/repo",
  "workspaceRoot": "C:/work/repo",
  "workspaceId": "default"
}
```

`kind` şu değerlerden biri olabilir: `shell`, `file_read`, `file_write`,
`network`, `memory`, `deployment`, `permission`, `automation`, `tool`. Alan
verilmezse araç adı ve argümanlardan türetilir. Eksik ajan, oturum veya araç
kimliği fail-closed `block` olur. Bilinmeyen araç ya da shell komutu otomatik
`allow` olmaz; en az `review` ister.

## Agent identity (capability card)

Zarftaki `agentName`/`sessionId` bir taşıma alanıdır: "bir şey oldu" der, "hangi
kimlik, hangi yetkiyle, kimin adına yaptı" demez. Faz C (#1769) bunun için
`huqan.agent-identity-card.v1` kartını ekler ve kararı **her** receipt'e yazar.

```json
{
  "schemaVersion": "huqan.agent-identity-card.v1",
  "agentId": "future-agent-2035",
  "agentName": "future-agent-2035",
  "agentVersion": "1.4.0",
  "ownerActorId": "actor:ali",
  "onBehalfOf": "actor:ali",
  "workspaceId": "default",
  "capabilities": ["file_read", "shell"],
  "delegationChain": ["orchestrator", "future-agent-2035"],
  "issuedAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": null
}
```

`capabilities` zarfın `kind` sözlüğünden değer alır; `*` hepsini kapsar.
`delegationChain` verilirse son eleman `agentId` olmak zorundadır. Kart
zarfın `identity` alanında ya da CLI'da `--identity-card <dosya>` ile verilir —
CLI'dan gelen kart ajanın kendi payload'ındaki kartı geçersiz kılar, çünkü bir
ajan kendi yetkisini kendisi beyan edemez.

Kart **verildiğinde** enforcement fail-closed'dır: geçersiz şema, workspace veya
ajan adı uyuşmazlığı, süresi geçmiş/henüz geçerli olmayan kart ve kartın
vermediği bir capability `block` olur. Karar `identity` gate finding'i olarak
kararın içine, kimlik de `metadata.identity` olarak receipt'e yazılır — yani
canonical receipt hash'inin kapsamındadır.

Kart **verilmediğinde** eylem yine attribute edilir (`attested: false`,
`ownerActorId: "unattested"`) ama karar değişmez. Kartı zorunlu kılmak bir
deployment kararıdır: `--require-identity`, library'de
`requireIdentityCard: true | 'review'`, ya da
`HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY=1|review`. Böylece kimlik açmak, kartı
henüz taşımayan mevcut uyarlayıcıları sessizce kırmaz.

### Kart imzası (ed25519)

`lib/external-action-identity-signing.js` kartın kanonik serileştirmesi
üzerine detached bir ed25519 imzası üretir ve doğrular. İmza, kartın yanında
zarfın `identityCardSignature` alanında (CLI'da
`--identity-card-signature <dosya>`) taşınır; kanonik serileştirme
kullanıldığı için anahtar sırası imzayı bozmaz, ama herhangi bir alan
değişikliği bozar.

Doğrulama, deployment'ın verdiği `trustedPublicKeys` ile yapılır (CLI'da
`--trusted-identity-keys <dosya>` — PEM'ler `-----END PUBLIC KEY-----`
satırıyla ayrılır). Anahtar dağıtımı bu modülün işi değildir ve şu an hiçbir
modülün işi değildir — registry, iptal yayını ve federasyon #1787'de açık
iştir; bugün anahtarı deployment elle taşır. Modül yalnız
doğrular ve her türden bozuk girdide fail-closed `false` döner.

İmza doğrulaması ayrı, sıkı opt-in bir deployment kararıdır:
`--require-signed-identity`, library'de
`requireSignedIdentityCard: true | 'review'`, ya da
`HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY=1|review`. Zorunlu kılındığında
imzasız veya doğrulama başarısız bir kart `block`/`review` olur. İmza
sonucu `identity.signatureVerified` alanına ve makbuza yazılır; `attested:
true` hâlâ yalnız "geçerli biçimli kart sunuldu" demektir —
`signatureVerified: true` olmadan makbuz kriptografik olarak doğrulanmış bir
fleet kimliğine bağlanmış sayılmaz. Merkezi makbuz toplamanın (#1781)
önkoşulu budur.

> Bu, external-action guard'a özgü basit capability card sözleşmesidir ve
> `lib/agent-identity-runtime.js` ile kablolanmış değildir. V5 Agent Identity
> runtime'ı artık kodda vardır: receiver-owned workspace authority snapshot'ı,
> canonical identity hash'i, süre/revocation alanları, delegation zinciri ve
> capability/tool/connector/risk sınırlarını fail-closed değerlendirir. Ancak
> bu runtime kriptografik capability-card imzası doğrulamaz, anahtar dağıtmaz ve
> harici bir identity provider'dan attestation almaz. CLI, HTTP/workflow, MCP
> approval ve external-client mutation yollarındaki kullanımı da explicit
> opt-in dilimlerdir; bütün runtime yüzeyleri için global enforcement değildir.
> Dolayısıyla V5 runtime'ın varlığı, bu guard kartını imzalı veya V5 tarafından
> doğrulanmış yapmaz.

### Bir kimliğin tüm eylemlerini listelemek

Receipt trail'i salt-okunur sorgulanır — ne graph açar ne de bir admission
sink'ine yazar:

```powershell
huqan-gate --identity-log agent:default:future-agent-2035 --receipt-log C:\logs\receipts.jsonl
huqan-gate --identity-log future-agent-2035 --owner actor:ali --since 2026-01-01T00:00:00.000Z --limit 50
```

`--identity-log` `agent:` ile başlıyorsa `identityRef`, aksi halde `agentId`
olarak yorumlanır. Çıktı eşleşen action'ları ve bir özet (karar/araç kırılımı,
`attested` sayısı, ilk/son zaman) döner; `truncated` alanı `limit`'in cevabı
kesip kesmediğini söyler. Aynı sorgu library'den
`queryExternalActionsByIdentity()` ile de yapılır. Kimlik kalıcılığından önce
yazılmış receipt'ler cevaptan düşürülmez; `legacy: true` ve `attested: false`
ile işaretlenir.

## Graduated autonomy (T1 / T2 / T3)

Faz D (#1770) dış action receipt geçmişinden identity-bazlı bir güven skoru
hesaplar: başarılı outcome, ihlal (`block`/`failed`) ve insan review oranları
ayrı tutulur. Yalnız canonical `receiptHash`'i doğrulanan receipt'ler pozitif
kanıt olabilir; eksik veya değiştirilmiş satırlar promotion üretemez.

| Tier | Yetki tavanı |
|---|---|
| `T1` | Salt-okuma ve sandbox simulation |
| `T2` | T1 + workspace-bounded filesystem/memory write |
| `T3` | Genişletilmiş action sınıfları; mevcut güvenlik gate'leri yine geçerli |

Promotion yavaştır: T2 için en az 10 action, 75 skor ve 5 kesintisiz başarı;
T3 için 30 action, 90 skor ve 10 kesintisiz başarı gerekir. İlk T1→T2 geçişi
`approved` bir insan activation kaydı olmadan yapılmaz. Demotion bekleme serisi
kullanmaz: yeni `failed` outcome bir tier, yeni `block` doğrudan T1 düşürür;
demotion eşikleri T2 için 60, T3 için 80'dir. Tier bir **yetki tavanıdır**;
AB1–AB11'den gelen `review` veya `block` kararını asla `allow`'a yükseltmez.
Promotion ayrıca `attested: true` capability-card kimliği ister; yalnız ajan
adından türetilen unattested kimlik geçmişi devralamaz ve T1'den çıkamaz.

Özellik geriye dönük uyumluluk için opt-in'dir:

```powershell
$event | huqan-gate --profile generic --graduated-autonomy --receipt-log C:\logs\receipts.jsonl
$event | huqan-gate --profile generic --graduated-autonomy `
  --autonomy-activation approval-42 --human-approver actor:ali `
  --approved-at 2026-01-01T00:10:00.000Z
```

Library'de `graduatedAutonomy: { enabled: true, receipts?, receiptPath?,
activation? }`, deployment ortamında
`HUQAN_EXTERNAL_GUARD_GRADUATED_AUTONOMY=1` kullanılabilir. Hesaplanan tier,
skor, oranlar, transition ve ilk activation kanıtı admission receipt'in
`metadata.autonomy` alanına hash kapsamında yazılır; outcome aynı kararı
admission receipt'ten miras alır. Promotion/demotion receipt'i kalıcı
yazılamazsa geçiş fail-closed `block` olur; yalnız bellekte yetki artışı yoktur.

## Continuous post-action monitoring (Faz E)

Pre-execution gate tek başına runtime sonucunu göremez. Host, eylem bittikten
sonra `recordExternalActionOutcome()` çağrısına `continuousMonitoring` vererek
bounded behavioral signal toplar. Bu yüzey yeni bir self-healer runner açmaz;
mevcut `behavioral-containment` değerlendirmesini ve finding classifier'ı
kullanır.

```js
recordExternalActionOutcome(invocation, admission.receipt, {
  status: 'success',
  durationMs: 42,
  sideEffectCount: 0,
  behavioralObservation: {
    tool: 'Read',
    action: 'read',
    connector: 'local',
    targetClass: 'workspace_path',
    egressClass: 'none',
    delegationClass: 'none',
  },
}, {
  receiptWriter,
  continuousMonitoring: {
    enabled: true,
    activation: {
      status: 'approved',
      approvalId: 'approval-123',
      actor: 'actor:operator',
      actorType: 'human',
      approvedAt: '2026-01-01T00:00:00.000Z',
    },
    baseline: {
      goal: 'bounded external action monitoring',
      capabilities: ['read'],
      tools: ['read'],
      connectors: ['local'],
      targetClasses: ['workspace_path'],
      egressClasses: ['none'],
      delegation: ['none'],
    },
  },
});
```

İlk kurulumda onaylı ve geleceğe tarihlenmemiş bir insan aktivasyonu
zorunludur. Aktivasyon yoksa sinyal receipt'e `activation_required` olarak
yazılır fakat otomatik containment devreye girmez. Aktif bir baseline sapması,
`policyViolation`, `unexpectedSideEffect` veya açık `anomaly` sinyali:

- mevcut self-healer finding şemasında sınıflanır;
- outcome receipt'in `metadata.monitoring` alanına hash-kapsamlı yazılır;
- receipt durable yazılmışsa identity'yi quarantine eder ve Faz D için kritik
  ihlal sayılarak bir sonraki kararda T1'e demote eder;
- durable receipt yoksa `ok:false` döner ve quarantine uygulanmış sayılmaz.

Continuous monitoring açıldığında Faz D autonomy tavanı aynı receipt kaynağıyla
otomatik etkinleşir; çağıranın ikinci bir feature flag vermesi gerekmez.
`continuousMonitoring.receipts` veya `receiptPath` açıkça verilebilir, aksi halde
durable writer yolu kullanılır.

Özellik varsayılan kapalıdır. Library seçeneğine ek olarak
`HUQAN_EXTERNAL_GUARD_CONTINUOUS_MONITORING=1` ile etkinleştirilebilir; yine de
baseline ve insan aktivasyonu verilmeden otomatik containment kurulmaz.

## Karar ve enforcement

Çekirdek mevcut HUQAN risk, tool-call, command, memory, automation, egress ve
cross-workspace gate'lerini yeniden kullanır. En sert karar kazanır:

| Çekirdek kararı | Executor |
|---|---|
| `allow` | Çalışabilir |
| `review` | İnsan kararı olmadan çalışmaz |
| `block` | Çalışmaz |

### Codex hook sözleşmesi (ölçüldü, codex-cli 0.151.0)

Codex ikilisi hook giriş/çıkış şemalarını kendi içinde taşıyor; aşağıdakiler
oradan çıkarıldı, tahmin değil.

`PreToolUse` **girdisi** şu alanların hepsini zorunlu tutar: `session_id`,
`tool_use_id`, `turn_id`, `tool_name`, `tool_input`, `cwd`, `model`,
`permission_mode` (`default | acceptEdits | plan | dontAsk |
bypassPermissions`), `agent_id`, `agent_type`, `transcript_path`. Adaptör
bunlardan `agent_id`, `agent_type`, `model` ve `permission_mode`'u makbuza
`metadata.host` altında **`attested: false`** ile yazar — host'un kendisi
hakkında söylediği şey, deployment'ın doğruladığı kimlik değil; `identity`
bloğuyla karıştırılmaz.

`PreToolUse` **çıktısında** şema `allow | deny | ask` listeler ama bu sürüm
üçünden ikisini reddediyor; ikilinin kendi hata metinleri: *"PreToolUse hook
returned unsupported permissionDecision:ask"* ve *"...:allow"*. Reddedilen bir
çıktı yok sayılan bir çıktıdır, yani `ask` göndermek `review`'ü **sessiz bir
allow'a** çevirirdi. Bu yüzden `review` de `deny` olarak uygulanır ve farkı
`permissionDecisionReason` taşır: "human decision pending, not a denylist
block", ayrıca makbuz kimliği. `deny` gönderirken gerekçe zorunludur (*"...
returned permissionDecision:deny without a non-empty permissionDecisionReason"*).

Ayrı bir `PermissionRequest` olayı da var; çıktısı `behavior: allow | deny` +
`message` kabul ediyor (`interrupt`, `updatedInput`, `updatedPermissions`
şimdilik fail-closed). Codex kullanıcıya onay sorduğunda HUQAN'ın gerekçesini
oraya iliştirmek mümkün — henüz bağlanmadı, çünkü PreToolUse zaten reddettiği
bir çağrı için onay istemi hiç oluşmuyor.

### Shell komutları hangi kategoriye düşer

Sırayla: deployment (`git push`, `npm publish`, …) → izin değişikliği (`chmod`,
`sudo`, …) → dosya yazma (`cp`, `rm`, `mkdir`, …) → **kompozisyon** → salt
okunur → geri kalan her şey `TOOL_CHAIN_EXECUTION`, yani `review`.

**Kompozisyon** ayrı bir adım: içinde yönlendirme, boru, zincirleme veya
ikame (`>`, `>>`, `<`, `|`, `;`, `&`, `` ` ``, `$(`, `${`) geçen bir komut asla
salt okunur sayılmaz. Sebebi ölçüldü: `ls -la > out.txt` bir dosya yazma,
`type gizli.json > disari` bir kopyalama; güvenli liste yalnız baştaki fiili
tanıdığı için ikisi de `allow` alıyordu (#1799).

Salt okunur liste yan etkisiz komutları kapsar (`ls`, `pwd`, `git status|diff|
log|show|branch|rev-parse|remote`, `rg`, `grep`, `find`, `type`, `cat`, `head`,
`tail`, `wc`, `echo`, `stat`, `date`, `du`, `df`, `Get-*`) ve `<komut>
--version` biçimindeki sürüm sorgularını.

### Deployment komut listesi

Geri kalan her şeyin `review` alması bilinçli ("bilinmeyen sessizce
geçmez") ama ayarlanabilir olmalı; yoksa `npm test` için her turda onay isteyen
bir kapı kapatılır ve elde ne engelleme ne makbuz kalır. Bunun için bir dosya:

```jsonc
// varsayılan: receipt trail'in yanında external-action-policy.json
// (HUQAN_EXTERNAL_GUARD_POLICY ile ya da --policy <dosya> ile değiştirilir)
{ "allowedCommands": ["npm test", "npm run lint", "node"] }
```

Kural: bir girdi komutun tamamıyla ya da **tam argüman sınırında** eşleşir —
`npm test`, `npm test -- --watch`'ı kapsar, `npm testify`'ı kapsamaz. Liste
yalnızca sınıflandırıcının "bilinmeyen tool-chain" diyeceği bir komutu salt
okunura yükseltebilir: deployment, izin ve yazma kategorileri ile denylist
**değişmez**, kompozisyon içeren komut hiç yükseltilmez. Bir izin listesi
kararının makbuzunda `metadata.allowlistedCommand` hangi girdinin geçirdiğini
yazar; okunamayan bir politika dosyası sessiz `allow` değil fail-closed hatadır.

Dosya çağrı anında okunur (mtime ile önbelleklenir), yani uzun ömürlü bir
editörde kurulumu ya da hook komutunu değiştirmeden düzenlenebilir — hook
komutunun değişmesi host'un güven kaydını düşürdüğü için bu önemli.

Guard yalnızca yürütmeden **önce** çağrıldığında enforcement sağlar. Bir ajan
pre-tool hook sunmuyorsa komutu yalnızca log'dan sonradan görmek yetmez; ajanı
`huqan-gate` kararına uyan bir wrapper, MCP gateway veya OS sandbox içinde
çalıştırmak gerekir. Bu bağlantı kurulmadan HUQAN o ajanın eylemini durdurduğunu
iddia etmez.

## Guard'ın kendi kontrol düzlemi

Her profil, koruduğu workspace'in **içinde** duran bir config dosyasıyla
bağlanır. Bu dosya guard'ın çalışıp çalışmayacağına karar verir, dolayısıyla
sıradan bir kaynak dosyayla aynı kefeye konamaz: Claude Code profilinde
`review` → `ask` demektir ve her yazma zaten `ask` ürettiği için, alışkanlıkla
verilen tek bir onay guard'ı sonraki tüm eylemler için kaldırır.

Bu yollara yazma, silme veya yeniden yazma `block`'tur — profilden bağımsız:

| Profil | Korunan yol |
|---|---|
| Claude Code | `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks.json`, `.claude/hooks/**` |
| Codex | `.codex/hooks.json`, `.codex/hooks/**` |
| OpenCode | `.opencode/plugin/**` |
| Pi | `.pi/extensions/**` |
| Hermes | `.hermes/plugins/**` |
| HUQAN | `adapters/external-action/**` |

Config'i **okumak** kısıtlanmaz. `cat`, `grep` ve `git diff` bir operatörün
guard'ın bağlı olduğunu doğrulama yoludur; bunları da işaretlemek insanları
kontrol düzlemi uyarılarını onaylamaya alıştırırdı.

Bakım gerçek bir ihtiyaç olduğu için blok mutlak değil: `--allow-control-plane`
bayrağı muafiyeti verir. Bayrak, hook'u kuran deployment'tan gelir ve
invocation payload'ından **okunmaz** — ajan muafiyeti kendi kendine
isteyemez. Bu, capability card'ın `evaluateHookInvocation` içinde options'tan
bağlanmasıyla aynı gerekçedir.

Bu bir sandbox değildir. Ajan config'i bu gate'in görmediği bir yoldan
değiştirebiliyorsa (guard'ın hiç bağlı olmadığı bir istemci, onaylanmış bir alt
süreç, doğrudan dosya sistemi erişimi) blok geçerli değildir.

## CLI ve genel uyarlayıcı

Paket kurulunca `huqan-gate` stdin'den native veya generic JSON event okur:

```powershell
$event | huqan-gate --profile generic --workspace-root C:\work\repo
```

Generic exit sözleşmesi `allow=0`, `review=3`, `block=2`'dir. Wrapper yalnızca
exit `0` olduğunda gerçek executor'ı çağırmalıdır. Parse, gate veya receipt
kalıcılık hatası exit `2` ile fail-closed döner. Input 1 MiB, her receipt satırı
64 KiB ile sınırlıdır.

Her karar için canonical admission receipt üretilir. Ham komut ve secret receipt'e
yazılmaz; input SHA-256 digest'i ve bounded finding alanları tutulur. Defaultta
receipt hem append-only JSONL trail'e hem de SQLite kullanılabiliyorsa HUQAN
`audit_log` tablosuna yazılır. Yollar gerektiğinde `--receipt-log`,
`--memory-path` ve `--db-path` ile sabitlenebilir. Receipt yazılamazsa eylem
çalışmaz.

Executor tamamlandığında library API ile ayrı outcome receipt yazılır:

```js
const {
  evaluateExternalAction,
  recordExternalActionOutcome,
} = require('huqan');

const admission = evaluateExternalAction(invocation, { receiptWriter });
if (!admission.canExecute) return admission;
const output = await executor();
recordExternalActionOutcome(invocation, admission.receipt, {
  status: 'success',
  output,
}, { receiptWriter });
```

## Mevcut uyarlayıcı profilleri

| İstemci | Bağlantı | `review` davranışı | Kapsam |
|---|---|---|---|
| Claude Code | `PreToolUse` command hook, `--profile claude-code` | `ask` | Hook'a gelen araç çağrıları |
| Codex | `PreToolUse` command hook, `--profile codex` | Güvenli varsayımla `deny` | Hook'a gelen araç çağrıları; devam eden bir `write_stdin` aynı tool call için yeniden hook üretmez |
| OpenCode | `createOpenCodeGuardPlugin()` | exception ile durdurur | `tool.execute.before` event'leri |
| Pi | `registerPiGuard(pi)` | `{ block: true }` | `tool_call` event'leri |
| Hermes | `--profile hermes` | `{ action: "block" }` | `pre_tool_call` hook event'leri |
| Gelecekteki/özel ajan | `generic` profil veya doğrudan library API | exit `3` / host kararı | Ortak zarfa çevrilip pre-execution bağlanan çağrılar |

### Kurulum, durum ve kaldırma

Kurulum komutu profil ile hedef şemayı birlikte doğrular, mevcut hook'ları
koruyarak yalnız HUQAN girişini ekler ve aynı komut tekrarlandığında ikinci bir
giriş üretmez:

```powershell
npx huqan-gate install --profile codex
npx huqan-gate install --profile opencode
npx huqan-gate status
npx huqan-gate uninstall --profile codex
```

`claude-code`, `codex`, `opencode` ve `pi` varsayılan olarak mevcut çalışma
dizinine; `hermes` kullanıcı home dizinindeki plugin yoluna kurulur. İzole
deployment veya test için hedefler `--target-root` ve `--home` ile verilebilir.
JSON config bozuksa ya da HUQAN'a ait hedef dosya yerel olarak değiştirilmişse
komut üzerine yazmaz. `uninstall` da yalnız HUQAN hook girişini veya içeriği
paket şablonuyla birebir aynı HUQAN dosyasını kaldırır.

`opencode` ve `pi` için kurulan dosya `huqan` paketini **adıyla** import eder.
Node bu adı kurulan dosyanın bulunduğu dizinden yukarı doğru arar ve **global
npm kurulumu bu aramaya görünmez**. Bu yüzden kurulum, hedeften paketin
çözülüp çözülmediğini önceden kontrol eder; çözülemiyorsa hiçbir şey yazmadan
reddeder. Çözüm, paketi hedef çalışma alanına kurmaktır (`npm install huqan`).

Başarılı `install` çıktısındaki `sentinel`, seçilen profil üzerinden bilinen
yıkıcı bir eylemin gerçekten `block` aldığını gösterir. `via` alanı bunun
**neyle** kanıtlandığını söyler:

- `via: "artifact"` (`opencode`, `pi`): kurulan dosya ayrı bir süreçte, kendi
  dizininden çözülerek yüklenir ve host'un sözleşmesiyle (`tool.execute.before`
  / `tool_call`) çağrılır. Yüklenemeyen, guard API'sine erişemeyen ya da
  engellerken makbuz bırakmayan bir artefakt kurulumu **başarısız eder**; o
  çağrının yazdığı dosya geri alınır (#1792).
- `via: "command"` (`claude-code`, `codex`): config'e **yazılmış olan** komut —
  bu süreçte yeniden çözülen değil — sentinel payload'ıyla ve **host'un
  kullanabileceği her kabukta** (Windows'ta cmd.exe *ve* PowerShell, POSIX'te
  sh) çalıştırılır. Başlatılamayan, herhangi bir kabukta farklı karar veren ya
  da makbuz bırakmayan komut kurulumu **başarısız eder**; o çağrının eklediği
  hook girişi geri alınır. Çıktıdaki `command` neyin kaydedildiğini, `shells`
  ise iddianın hangi yorumlayıcılarda sınandığını söyler.
- `via: "evaluator"` (`hermes`): Hermes'in Python plugin'i gate
  çalıştırılabilirini kendi içinde PATH ya da `HUQAN_GATE_PATH` üzerinden
  çözüyor — kurulumun host adına ayarlayabileceği bir şey değil — bu yüzden
  doğrulama yalnızca karar yolunun kurulumu yapan süreç içinde engellediğini
  gösterir. Kapının o istemcide canlı olduğunun ucu uca kanıtı değildir.

Hook komutu kurulum anında **çalıştırılarak** seçilir. Adaylar taşınabilir
olandan başlayarak sırayla denenir — `HUQAN_GATE_PATH` → PATH üzerindeki
`huqan-gate` → çalışma alanının `node_modules/.bin` shim'i → `node <mutlak
giriş>` → mutlak Node ikilisi — ve **her kabukta sentinel'i engelleyen ilk
aday** kaydedilir. Hiçbiri geçmezse kurulum, neyi denediğini söyleyerek
reddeder.

Komut **tırnaksız** yazılır; boşluklu yollar Windows kısa adına (`PROGRA~1`)
çevrilir, çevrilemezse o aday elenir. Sebebi: tırnaklı yol PowerShell'de
`& ` olmadan sözdizimi hatası, `&` ile başlayan komut ise cmd.exe'de hata —
yani her iki kabukta çalışan tırnaklı bir yazım yok. Şablonlardaki düz
`huqan-gate --profile X` de yalnız o ad PATH'te olduğunda çalışıyordu (#1792);
kaydedilen mutlak tırnaklı biçim ise Codex'in kabuğunda hiç başlamıyor, hook
`exit 1` veriyor ve **Codex komutu yine de çalıştırıyordu** (#1797) — fail-closed
bir guard'ın host tarafından fail-open'a çevrilmesi.

Sentinel gerçek eylemi çalıştırmaz; doğrulamanın ürettiği makbuz ve (CLI
yolunda) açılan graph geçici bir dizine yazılır, deployment'ın receipt trail'ine
dokunulmaz. `status`, her
profilin hedefini/bağlılık durumunu ve varsa varsayılan ya da `--receipt-log`
ile seçilen trail'deki son receipt'in zaman, karar ve kimliğini döndürür.

Bu yönetim yolu guard kontrol düzlemine kasıtlı deployment yazımıdır. Library
API'si `deploymentAuthorized: true` olmadan install/uninstall/status çalıştırmaz;
bu yetki hook payload'ından okunmaz ve ajanın kendi eylemine taşıyabileceği
`--allow-control-plane` muafiyeti değildir.

Kurulabilir başlangıç şablonları paketin `adapters/external-action/` dizinindedir:

- Claude Code: `claude-code-hooks.json` içeriğini proje `.claude/settings.json`
  dosyasındaki `hooks` alanına birleştir.
- Codex: `codex-hooks.json` dosyasını proje `.codex/hooks.json` konumuna kopyala
  veya mevcut hook dosyasına birleştir.
- OpenCode: `opencode-plugin.mjs` dosyasını `.opencode/plugin/huqan.mjs`
  konumuna koy.
- Pi: `pi-extension.js` dosyasını proje `.pi/extensions/huqan.js` konumuna koy.
- Hermes: `hermes/` dizinini `~/.hermes/plugins/huqan-external-action-guard/`
  konumuna koy. `huqan-gate` PATH üzerinde değilse mutlak executable yolunu
  `HUQAN_GATE_PATH` ile ver; ardından
  `hermes plugins enable huqan-external-action-guard` ile etkinleştir.

Şablonlar npm paketindeki HUQAN library/CLI'ını çağırır; kaynak checkout'a
bağımlı değildir. İstemcilerin hook şemaları zamanla değişebileceğinden kurulumda
güncel resmi hook belgeleriyle doğrulanmalıdır.

Referanslar: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[OpenCode plugins](https://opencode.ai/docs/plugins/),
[Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md),
[Hermes plugin hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).

Yeni bir ajan eklemek için çekirdeğe ajan adı eklenmez. Yapılacak iş üç adımdır:

1. Native event'i ortak zarfa normalize et.
2. Guard'ı gerçek executor'dan önce bekle.
3. `review` ve `block` kararlarında executor'ın çağrılmadığını bir sentinel
   entegrasyon testiyle kanıtla.

## Bilinen sınırlar

- Bu v1 OS seviyesinde evrensel bir güvenlik çekirdeği veya IAM yerine geçmez.
- Cline, Kilocode ve JCode için bu sürümde doğrulanmış native pre-tool adapter
  yoktur; generic wrapper ile bağlanabilirler, aksi halde coverage iddia edilmez.
- Ağ erişimi, credential scope, branch protection ve container/sandbox
  yetkileri ayrıca enforce edilmelidir.
- Guard, onayladığı bir komutun **başlattığı** sürecin kendi tool çağrılarını
  görmez. `node my-agent.js` tek bir shell eylemi olarak değerlendirilir; o
  sürecin sonradan yaptıkları hook'tan geçmez.
- Kontrol düzlemi bloğu, guard'ın çağrıldığı yolları kapsar. Guard'ın hiç
  bağlı olmadığı bir istemci aynı dosyayı serbestçe değiştirebilir.
- Admission receipt eylemin değerlendirildiğini kanıtlar; eylemin çalıştığını
  outcome receipt olmadan kanıtlamaz.
- Guard capability card'ı imzalanmış değildir. Kartı guard'a veren süreç (hook
  config veya wrapper) güvenilir kabul edilir; kart deployment'ın verdiği yetki
  tanımıdır. `lib/agent-identity-runtime.js` receiver-owned authority ve
  canonical hash üzerinden ayrı bir opt-in runtime doğrulaması yapar, fakat o
  da kriptografik kart imzası veya anahtar dağıtımı sağlamaz. External-action
  guard bu runtime'ı çağırmadığı için iki güven modeli birbirinin yerine
  kullanılamaz. Bu nedenle farklı makinelerden toplanan guard receipt'leri,
  yalnız `attested: true` alanına bakılarak kriptografik olarak doğrulanmış bir
  fleet kimliğine bağlanmış sayılamaz. Kart için ayrı bir ed25519 imza
  katmanı vardır (yukarıda "Kart imzası"): `signatureVerified: true` bir
  makbuzu imzalayan anahtarın deployment'ın güvenilir anahtarlarından birine
  bağlar; ancak imza varsayılan olarak opsiyoneldir ve zorunlu kılınmadıkça
  imzasız makbuzlar bu sınıra takılır.
- Anahtar **dağıtımı** hiçbir katmanda çözülmüş değildir. Kart imzasını
  doğrulayan taraf güvenilir açık anahtarları deployment'tan alır
  (`--trusted-identity-keys`); A2A tarafında da authority tek bir yerel
  dosyadan okunur (`A2A_AUTHORITY_FILE`) ve agent card trust-root yayınlamayı
  kasten reddeder. Yani iki yabancı taraf birbirinin anahtarını protokol içinden
  öğrenemez; registry, iptal yayını ve federasyon açık iştir (#1787).
- Bu bölüm external-action guard kartı hakkındadır; "kriptografik doğrulama
  yok" diye okunmamalıdır. A2A yüzeyi imzalı çalışır:
  `lib/a2a/bounded-exchange.js` her hop'u ed25519 ile doğrular, imzalı
  delegasyon zincirini (`delegation_signature_invalid`) ve
  `expires_at`/`revoked_at` alanlarını fail-closed değerlendirir. Farklı olan
  şey doğrulamanın varlığı değil, hangi yüzeyde zorunlu olduğudur.
- `attested: true` yalnız "geçerli biçimli capability card sunuldu, normalize
  edildi ve bu çağrıya bağlandı" demektir. İmza doğrulandı, kart güvenilir bir
  issuer'dan geldi veya eylem kabul edildi demek değildir. Süresi geçmiş,
  henüz geçerli olmayan ya da kapsam dışı bir kart yine `attested: true` olur
  ve `block` alır. Kabul kararı `identity` gate finding'i ile receipt `decision`
  alanındadır. `attested: false` kimliğin zarftan türetildiğini gösterir; iki
  durum log sorgusunda ayrıştırılabilir.
