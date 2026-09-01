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
- Admission receipt eylemin değerlendirildiğini kanıtlar; eylemin çalıştığını
  outcome receipt olmadan kanıtlamaz.
