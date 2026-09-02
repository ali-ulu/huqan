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

> Bu basit karttır. `lib/agent-identity-runtime.js` (workspace authority
> snapshot'ı, imzalı delegation, revocation) hâlâ
> `docs/v5/v5-agent-identity-closeout-audit.md` gate'inin arkasındadır; burada
> V5 runtime identity enforcement iddia edilmez.

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

## Karar ve enforcement

Çekirdek mevcut HUQAN risk, tool-call, command, memory, automation, egress ve
cross-workspace gate'lerini yeniden kullanır. En sert karar kazanır:

| Çekirdek kararı | Executor |
|---|---|
| `allow` | Çalışabilir |
| `review` | İnsan kararı olmadan çalışmaz |
| `block` | Çalışmaz |

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
- Capability card imzalanmış değildir. Kartı guard'a veren süreç (hook config,
  wrapper) güvenilir kabul edilir; kart bir kimlik **beyanının** doğrulanmış
  taşıyıcısı değil, deployment'ın verdiği yetki tanımıdır. Kriptografik kimlik
  doğrulama V5 runtime'ının gate'i arkasındadır.
- `attested: true` "geçerli biçimli bir kart sunuldu ve bu çağrıya bağlandı"
  demektir; "eylem kabul edildi" demek değildir. Süresi geçmiş ya da kapsam dışı
  bir kart attested'dır ve `block` alır. Kabul kararı `identity` gate finding'i
  ve receipt `decision` alanındadır. `attested: false` ise kimliğin zarftan
  türetildiğini gösterir; iki durum log sorgusunda ayrıştırılabilir.
