# OpenHands Kurulumu — `huqan-gate` pre-execution guard

Bu belge, HUQAN'ı bir OpenHands ajanına iki ayrı yüzeyden nasıl bağlayacağını
anlatır: **gate** (çalışmadan önce denetim) ve **MCP** (araç sunma). İkisi
birbirinden bağımsızdır ve birlikte kullanılabilir.

- **Gate**, ajanın bir araç çağrısını çalıştırmasından önce devreye girer ve
  karar verir (`allow` / `review` / `block`). OpenHands bunu `pre_tool_use`
  hook'u üzerinden çağırır.
- **MCP**, ajana `huqan-mcp` araçlarını sunar. Çağrılıp çağrılmaması ajanın
  kararıdır; yani bir güvenlik sınırı değildir.

Bir sınır istiyorsan gate'i kur; araçları da istiyorsan MCP'yi ekle.

## MCP destek matrisi

| Platform | MCP desteği | Yapılandırma | Not |
| --- | --- | --- | --- |
| OpenHands CLI | Tam | `~/.openhands/mcp.json` | `/mcp` komutu canlı durumu gösterir; stdio, SSE, SHTTP desteklenir. |
| OpenHands SDK | Tam | Kod içinde programatik | Sunucu yaşam döngüsü üzerinde tam kontrol. |
| Local GUI | Tam | Ayarlar ekranı + config dosyası | Görsel yapılandırma ve yedekleme. |
| OpenHands Cloud | Tam | Cloud ayarları | Yönetilen barındırma, ekip paylaşımı. |

HUQAN tarafında MCP sunucusu her istemcide aynı config ile bağlanır:

```json
{
  "mcpServers": {
    "huqan": {
      "command": "npx",
      "args": ["-y", "--package=huqan", "huqan-mcp"]
    }
  }
}
```

`--package=huqan` zorunludur çünkü binary adı paket adından farklıdır.
Operatör araçları (`huqan.approve`, `huqan.approvals`, `huqan.approval_detail`,
`huqan.agent_resume`, `huqan.emergency_stop`) modelden gizlenir ve
`HUQAN_MCP_OPERATOR_TOKEN` gerektirir; böylece bir ajan kendi önerisini
onaylayamaz.

## OpenHands gate projeksiyonu

OpenHands hook'ları depo içindeki `.openhands/hooks.json` dosyasından okunur.
Biçim Claude Code ile uyumludur; tek fark, olay anahtarlarının snake_case
olmasıdır (`pre_tool_use`). Kurulum, HUQAN'ın her profilde yazdığı tek
`matcher: "*"` girdisini bu dosyaya ekler ve çalıştırmadan önce bir sentinel
ile gerçekten engellediğini kanıtlar.

| Yüzey | Değer |
| --- | --- |
| Config | `.openhands/hooks.json` (depo kökünde) |
| Olay | `pre_tool_use` |
| Komut | `huqan-gate --profile openhands` |
| Girdi | stdin'de flat JSON: `event_type`, `tool_name`, `tool_input`, `session_id`, `working_dir` |
| Çıktı | exit `0` geçir / `2` engelle, veya stdout'ta `{"decision":"allow"\|"deny","reason":...}` |

OpenHands hook sözleşmesi yalnız `allow` ve `deny` tanır; `ask` yoktur. Bu
yüzden HUQAN'ın `review` kararı `deny` olarak uygulanır ve farkı `reason`
alanı taşır ("human decision pending, not a denylist block" + makbuz kimliği).
Bu, Codex projeksiyonundaki desenin aynısıdır.

### Kurulum

```bash
# Önce tespit: OpenHands bu projede görünüyor mu, ne yapardı?
npx huqan-gate connect --detect

# Kur: .openhands/hooks.json içine gate girdisini yazar ve sentinel'i çalıştırır
npx huqan-gate install --profile openhands

# Durum ve kaldırma
npx huqan-gate status
npx huqan-gate uninstall --profile openhands
```

`connect` yalnız tespit edilen ajanları bağlar; zorla kurmak için
`install --profile openhands` kullan. Kurulum idempotenttir: ikinci çağrı yeni
girdi eklemez, mevcut girdiyi yerinde bırakır. Yerel olarak düzenlenmiş bir
HUQAN girdisini sessizce geri almaz; üzerine yazmayı reddeder.

Kurulum bir şey yazdığı için OpenHands'un hook'a yeniden güvenmesi
gerekebilir; `install` çıktısı bunu söyler.

### Kimlik kartını hook'a bağlama

Varsayılan dağıtımda **kimlik kartı zorunludur** (bkz. `docs/external-action-guard.md`
§ Agent identity), bu yüzden kartsız bir kurulumda zararsız bir komut bile
`agent_identity_card_required` ile bloklanır — bu OpenHands'a özel değil, tüm
profillerin ortak fail-closed davranışıdır. Kartı bir kez üret ve `install`'a
ver; gate kartı kaydedilen hook komutuna ekler, böylece ajan her çağrıda kartı
taşır:

```bash
# 1) İmza anahtar çifti ve kart (agent-id hook'un raporladığı agentName olmalı: openhands)
npx huqan-gate identity issue --generate-keypair ./keys
npx huqan-gate identity issue \
  --agent-id openhands --owner actor:ali \
  --capabilities shell,file_read,file_write \
  --out card.json \
  --sign-key ./keys/identity-card-private.pem

# 2) Kartı hook komutuna bağlayarak kur
npx huqan-gate install --profile openhands \
  --identity-card card.json \
  --identity-card-signature card.json.sig.json \
  --trusted-identity-keys ./keys/identity-card-public.pem
```

Kurulum kartı **silmez**: `--identity-card` verildiğinde `install`, komutu
kaydetmeden önce kartın zararsız bir eylemi gerçekten kabul ettiğini çalıştırarak
kanıtlar. Süresi geçmiş, yanlış ajan adına düzenlenmiş, güvenilmeyen anahtarla
imzalanmış veya gerekli capability'yi vermeyen bir kart kurulumu **reddettirir**
ve hiçbir şey yazılmaz; aksi halde hook kurulur ve her çağrı sessizce fail-closed
bloklanırdı. `--identity-card` ile `--trusted-identity-keys` birlikte verilmelidir;
yalnız biri verilirse kurulum nedenini söyleyerek durur. Kartı değiştirmek için
`install`'ı yeni kartla yeniden çalıştır: sahiplenilen girdi ikinci bir kopya
eklemeden yerinde güncellenir. Yerel olarak elle düzenlenmiş bir komut yine de
geri alınmaz; kurulum üzerine yazmayı reddeder.

Kartı hook'a bağlamadan yalnız denemek istersen kimlik zorunluluğunu geçici
olarak gevşetebilirsin:

```bash
echo '{"event_type":"PreToolUse","tool_name":"terminal","tool_input":{"command":"git status"},"session_id":"manual-check","working_dir":"'"$PWD"'"}' \
  | HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY=allow node bin/huqan-gate-hook.js --profile openhands
```

Bu, `{}` döndürür ve geçer. Kalıcı gevşetme yerine kartı bir kez üretip hook
komutuna bağlamak tercih edilir.

### Uçtan uca doğrulama

Kartı hook'a bağladıktan sonra, kaydedilen komutu doğrudan çalıştırarak gate'in
gerçekten çalıştığını ölçebilirsin. Girdi stdin'den gelir, çıktı stdout'tadır:

```bash
# Zararsız eylem: bağlı kart onu kabul eder -> {}
echo '{"event_type":"PreToolUse","tool_name":"terminal","tool_input":{"command":"git status"},"session_id":"manual-check","working_dir":"'"$PWD"'"}' \
  | node bin/huqan-gate-hook.js --profile openhands \
      --identity-card card.json \
      --identity-card-signature card.json.sig.json \
      --trusted-identity-keys ./keys/identity-card-public.pem

# Denylist'teki eylem: kart ne olursa olsun engellenir
echo '{"event_type":"PreToolUse","tool_name":"terminal","tool_input":{"command":"rm -rf /"},"session_id":"manual-check","working_dir":"'"$PWD"'"}' \
  | node bin/huqan-gate-hook.js --profile openhands \
      --identity-card card.json \
      --identity-card-signature card.json.sig.json \
      --trusted-identity-keys ./keys/identity-card-public.pem
```

Beklenen: ilki `{}`, ikincisi `{"decision":"deny","reason":"... DENYLISTED_COMMAND_BLOCKED ..."}`.
`session_id` zorunludur; eksik bir payload (`missing_session_id`) fail-closed
engellenir. `install` çıktısındaki `sentinel.command` alanı kaydedilen komutun
tam metnini verir; yukarıdaki elle çağrı yerine onu da kullanabilirsin.

Kartı hook'a bağlamadıysan zararsız bir komut bile `agent_identity_card_required`
ile bloklanır; bu beklenen fail-closed davranıştır ve çözümü yukarıdaki
§ Kimlik kartını hook'a bağlama adımıdır.

### Platform farkları

| Konu | OpenHands | Claude Code / Codex |
| --- | --- | --- |
| Config konumu | Depo içi `.openhands/hooks.json` | Kullanıcı/ev dizini ayarları |
| Olay anahtarı | `pre_tool_use` (snake_case) | `PreToolUse` (PascalCase) |
| Çıktı alanı | top-level `{decision, reason}` | `hookSpecificOutput.permissionDecision` |
| `ask` desteği | Yok | Claude Code `ask` kabul eder |
| Girdi cwd alanı | `working_dir` | `cwd` |

### Sınırlar

- Gate yalnız istemci onu çağırırsa uygular. Hook devre dışıysa hiçbir karar
  üretilmez; bu yüzden kurulum sentinel'i hook'un gerçekten engellediğini
  kanıtlamadan başarı dönmez.
- MCP yüzeyi bir güvenlik sınırı değildir; araç sunar, denetlemez. Denetim
  için gate gerekir.
- Bu belge yalnız kurulum ve sözleşmeyi anlatır; gate kararlarının tam
  gerekçesi `docs/external-action-guard.md` içindedir.
