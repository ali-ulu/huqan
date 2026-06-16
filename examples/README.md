# HUQAN — Examples

Bu klasörde HUQAN'ı denemek ve MCP server'ı test etmek için örnek dosyalar var.

---

## 📁 Dosyalar

| Dosya | Açıklama |
|-------|----------|
| [`mcp-self-test.js`](./mcp-self-test.js) | HUQAN MCP server'ını JSON-RPC over stdio ile test eden script. 9 aşama, 20 assertion. |
| [`mcp-claude-config.json`](./mcp-claude-config.json) | Claude Desktop / Cursor için örnek MCP config. |

---

## 🚀 Hızlı başlangıç

### 1. MCP server'ı test et

```bash
# Repo kök dizinindeyken:
node egitim.js                        # 5 saniye, graph'ı üret
node examples/mcp-self-test.js        # MCP server'ı test et
```

Beklenen çıktı:
```
=== SUMMARY ===
Pass: 20
Fail: 0

HUQAN MCP server sorunsuz calisiyor.
```

### 2. Claude Desktop'a ekle

[`mcp-claude-config.json`](./mcp-claude-config.json) dosyasını kendi kurulumunuza göre düzenleyin:

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

**Config dosyasının yeri:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`
- **Cursor:** Settings → MCP → Add new MCP server

Claude Desktop'ı **tamamen kapatıp** yeniden açın. Sonra Claude'a:

> "felsefe bilgelik sevgisidir mi? HUQAN ile doğrula."

---

## 🛠 Test edilen MCP tool'ları

`mcp-self-test.js` şu 7 tool'u çağırır:

| Tool | Test | Beklenen |
|------|------|----------|
| `axiom.ask` | "felsefe nedir" | "felsefe bilgelik sevgisi" |
| `axiom.verify` (true) | "felsefe bilgelik sevgisidir" | `dogrulandi` (0.90) |
| `axiom.verify` (unknown) | "mars ucagini tastir" | `bilinmiyor` (0) |
| `axiom.reason` | "felsefe" | forward/backward chain |
| `axiom.compare` | "mantik" vs "felsefe" | similarities/differences |
| `axiom.dream` | depth: 3 | ≥1 hipotez |
| `axiom.policy` | "axiom.verify" | policy data |

Toplam 10 MCP tool var. Detaylar için [`docs/mcp-quickstart.md`](../docs/mcp-quickstart.md).

---

## 📚 Daha fazla

- [MCP Quick Start (detaylı rehber)](../docs/mcp-quickstart.md)
- [Troubleshooting](../docs/mcp-quickstart.md#-troubleshooting)
- [Genel README](../README.md)
- [Statik demo sayfası](../demo/index.html)

---

## 📄 Lisans

Apache License 2.0 — repo ile aynı.
