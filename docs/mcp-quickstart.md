# HUQAN MCP Server — Quick Start

**Model Context Protocol (MCP)** üzerinden HUQAN'ı Claude Desktop, Cursor veya herhangi bir MCP client ile kullanın.

> **MCP nedir?** Anthropic'in 2024'te yayınladığı standart. LLM'lerin dış araçlarla konuşma şekli. HUQAN MCP server olarak çalışır, Claude ise MCP client.

---

## ⚡ 60 saniyede kurulum

### 1. Repo'yu klonla + graph'ı üret

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
npm ci --include=optional      # ~1 saniye
node egitim.js                  # ~5 saniye, 77 Türkçe gerçek yükler
```

### 2. MCP server'ı test et

```bash
node examples/mcp-self-test.js
```

Beklenen çıktı:
```
=== SUMMARY ===
Pass: 20
Fail: 0

HUQAN MCP server sorunsuz calisiyor.
```

Eğer bir FAIL görürseniz, [Troubleshooting](#-troubleshooting) bölümüne bakın.

### 3. Claude Desktop config'ine ekle

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

Şunu ekleyin (örnek config: [`examples/mcp-claude-config.json`](../examples/mcp-claude-config.json)):

```json
{
  "mcpServers": {
    "huqan": {
      "command": "node",
      "args": ["/absolute/path/to/axiom/mcpServer.js"],
      "env": {
        "AXIOM_MEMORY_PATH": "/absolute/path/to/axiom/memory.json",
        "AXIOM_DB_PATH": "/absolute/path/to/axiom/memory.db",
        "AXIOM_USE_SQLITE": "true"
      }
    }
  }
}
```

**Önemli:** `/absolute/path/to/axiom/` kısmını kendi kurulum yolunuzla değiştirin.

### 4. Claude Desktop'ı yeniden başlat

- macOS: `Cmd+Q` → yeniden aç
- Windows: System tray → quit → yeniden aç
- Linux: `killall claude` → yeniden aç

### 5. Claude'da dene

Claude'a şunu yaz:

> "felsefe bilgelik sevgisidir mi? HUQAN ile doğrula."

Claude `axiom.verify` MCP tool'unu çağırır ve size döner:

> ✅ **Doğrulandı** (confidence: 0.90)
> Evidence: `felsefe --[tür]--> bilgelik sevgisi`

---

## 🛠 Kullanılabilir 10 MCP tool

| Tool | Ne yapar | Örnek |
|------|----------|-------|
| `axiom.ask` | Graph'tan soru sor | `ask: "felsefe nedir"` |
| `axiom.verify` | İddia doğrula | `verify: "felsefe bilgelik sevgisidir"` |
| `axiom.reason` | Nedensel akıl yürüt | `reason: "mantik"` |
| `axiom.compare` | İki kavramı karşılaştır | `compare: "mantik" vs "felsefe"` |
| `axiom.dream` | Hipotez üret | `dream: { depth: 3 }` |
| `axiom.learn` | Graph'a bilgi ekle | `learn: "yeni bir gerçek"` *(default: review gerekir)* |
| `axiom.plan` | Hedef için plan üret | `plan: "B737 güvenli iniş prosedürü"` |
| `axiom.agent` | Agent runtime çalıştır | `agent: "complex task"` |
| `axiom.policy` | Tool policy incele | `policy: { tool: "axiom.verify" }` |
| `axiom.approvals` | Pending onayları listele | `approvals: { limit: 10 }` |

---

## 🌐 Cursor'a ekleme

Cursor: **Settings → MCP → Add new MCP server**

- **Type:** stdio
- **Command:** `node`
- **Args:** `/absolute/path/to/axiom/mcpServer.js`
- **Env:** `AXIOM_MEMORY_PATH`, `AXIOM_DB_PATH`, `AXIOM_USE_SQLITE=true`

---

## 🔧 Environment Variables

| Variable | Default | Açıklama |
|----------|---------|----------|
| `AXIOM_MEMORY_PATH` | `memory.json` | JSON hafıza dosyası |
| `AXIOM_DB_PATH` | `memory.db` | SQLite DB dosyası |
| `AXIOM_USE_SQLITE` | `true` | `false` = JSON-only mode |
| `AXIOM_LANG` | `tr` | NLP dili: `tr` / `en` / `de` / `ar` / `auto` |
| `AXIOM_PARANOID` | `0` | `1` = paranoid mode (LLM öğrenmeyi kapat) |
| `AXIOM_API_KEY` | — | HTTP server için (MCP için gerekmez) |
| `AXIOM_KERNEL_VERSION` | `v1` | `v2` = KernelV2 (zengin verify) |

---

## 🚨 Troubleshooting

### "memory.json bulunamadi"

```bash
node egitim.js   # önce graph'ı üret
```

### "EADDRINUSE: port 3000"

MCP server **port kullanmaz** — stdio üzerinden konuşur. Bu hatayı görürseniz, `server.js`'i durdurun (HTTP server).

### "Tool call blocked by gate"

`axiom.learn` default olarak **review** statüsündedir (V2.6 güvenlik gate). Bu bilinçli bir karar:

- **Geçici çözüm:** MCP üzerinden graph'a yeni bilgi eklemek yerine, `node egitim.js` veya CLI ile `learn:` komutunu kullanın
- **Kalıcı çözüm:** `lib/mcp-gate-adapter.js:20`'de `axiom.learn` için `alphaDecision: 'allow'` yapın (production'da önerilmez)

### "verify bilinmiyor dönüyor"

Graph'ta o kavram yok. Komutları deneyin:

```bash
node cli.js
> ask: kedi nedir
> learn: kedi hayvandir
> verify: kedi hayvandir
```

### Claude "HUQAN tool'ları görmüyor"

1. `claude_desktop_config.json`'da JSON syntax hatası var mı kontrol edin:
   ```bash
   cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | python3 -m json.tool
   ```
2. `/absolute/path/to/axiom/mcpServer.js` yolunun doğru olduğundan emin olun
3. Claude Desktop'ı **tamamen kapatın** (Cmd+Q) ve yeniden açın
4. Claude'da `!mcp` yazın — HUQAN listelenmeli

### "Plugin yuklenemedi: company-brain.js"

Bu hata değil, **bilgilendirme**. `companyMode` capability default off. MCP için gerekmez, görmezden gelin.

---

## 🧪 MCP Self-Test

`examples/mcp-self-test.js` 9 aşamalı test:

1. `initialize` handshake
2. `tools/list` — 10 tool
3. `axiom.ask` — graph'tan soru
4. `axiom.verify` (true claim) — semantic trust + reasoning trace
5. `axiom.verify` (unknown claim) — `bilinmiyor` dönüşü
6. `axiom.reason` — forward/backward chain
7. `axiom.compare` — iki kavram karşılaştırma
8. `axiom.dream` — hipotez üretimi
9. `axiom.policy` — tool policy

Toplam **20 assertion**. Hepsi `[OK]` olmalı.

---

## 📚 Daha fazla bilgi

- [Repo README](../README.md) — genel bakış
- [Demo showcase](../demo/index.html) — statik demo
- [Architecture](architecture.md) — modül haritası
- [ATP spec](../specs/axiom-trust-protocol/0.1/README.md) — Trust Protocol
- [Security](SECURITY-GATE.md) — güvenlik gate'leri

---

## 🤝 Katkıda bulunma

Bir bug bulursanız:

1. `node examples/mcp-self-test.js` çıktısını kopyalayın
2. GitHub issue açın: https://github.com/agiulucom42-del/axiom/issues
3. `[FAIL]` satırını ve `mcp-stderr` çıktısını ekleyin

PR'ler memnuniyetle karşılanır. `AGENTS.md` kurallarına uyun.
