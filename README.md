# ◇ AXIOM

**LLM'ler için deterministik doğrulama motoru.**

LLM çıktılarını doğrular, çelişkileri tespit eder, nedensellik zinciri kurar. GPU yok, bulut API yok. (better-sqlite3 opsiyonel bağımlılıktır).

> *"LLM'ler kumdan kale. AXIOM granit."*

---

## Hızlı Başlangıç

```bash
npm install
node egitim.js   # Başlangıç bilgi tabanını yükle
node cli.js      # CLI
node server.js   # Web arayüzü → http://localhost:3000
node mcpServer.js  # Claude Desktop / Cursor için MCP sunucu
```

Node.js >= 18 gereklidir. better-sqlite3 veritabanı kalıcılığı için opsiyonel (native) bağımlılıktır.

AXIOM v0.8 introduces the Trust Kernel and AXIOM Trust Protocol v0.1: provenance, trust policy, append-only audit, workspace scoping, conflict quarantine, Trust Receipts, ATP/AVP conformance, `.axiom` package format draft, and the minimal `axiom-verify` package skeleton.

---

## Ne Yapar?

```
LLM (Ollama/OpenAI)     Kullanıcı (CLI/REST/MCP)
       |                         |
       v                         v
   llmAdapter               kernel.v2
       |                         |
       +-----→ verify() ←--------+
                    |
             [Çelişki var?]
              /           \
            Evet          Hayır
             |              |
        Uyarı + reddet   Öğren + kaydet
```

| Özellik | AXIOM | LLM-only |
|---|---|---|
| Doğrulama | Deterministik, sembolik | Olasılıksal |
| Çelişki tespiti | Evet (olumsuzlama, zıt, çok adımlı) | Hayır |
| Hafıza | Kalıcı SQLite + JSON | Bağlam penceresi |
| GPU/Bulut | Gerekmez | Gerekir |
| Maliyet | $0 | $/sorgu |
| F1 (doğrulama) | 0.88â€“0.91 | 0.82â€“0.86 |
| Dil | Türkçe + İngilizce | İngilizce ağırlıklı |

---

## CLI Komutları

### Temel Öğrenme ve Sorgulama

| Komut | Açıklama |
|---|---|
| `kedi hayvandır` | Bilgi öğret |
| `kedi nedir` | Soru sor |
| `sor: kedi nedir` | Açık soru |
| `öğret: kedi balık yer` | Açık öğret |
| `neden tavuk` | Nedensellik zinciri |
| `tavuk mu yumurta mı` | Karşılaştır |

### Sistem

| Komut | Açıklama |
|---|---|
| `durum` / `nasılsın` | Düğüm/kenar/entropi/çelişki özeti |
| `rüya` | Hipotez üret |
| `açık düşün` | Arka planda otomatik hipotez |
| `dur düşünme` | Otomatik düşünmeyi durdur |
| `optimize` | Zayıf kenarları buda |
| `kaydet` | Hafızayı diske yaz |
| `çıkış` / `bb` | Çıkış (otomatik kaydeder) |

### LLM ve Belge

| Komut | Açıklama |
|---|---|
| `llm-sor: soru` | LLM'ye sor → doğrula → otomatik öğren |
| `yükle: dosya.txt` | `.txt` / `.md` dosyasından öğren |

---

## REST API

```bash
node server.js   # http://localhost:3000
```

### Endpoints

```
GET  /api?q=kedi+nedir
GET  /dogrula?statement=kedi+hayvandir
POST /dogrula    { "statement": "kedi hayvandır" }
POST /yukle      { "text": "kedi hayvandır\nköpek memelidir" }
POST /llm-sor    { "question": "kedi nedir?", "autoLearn": true }
GET  /graph-data
```

`/dogrula` cevabı: `{ "status": "dogrulandi" | "celiski" | "bilinmiyor", "confidence": 0.9, "evidence": [...] }`

---

## MCP Sunucu

Claude Desktop, Cursor ve diğer MCP destekli araçlar için:

```bash
node mcpServer.js
```

Araçlar: `axiom.learn` · `axiom.ask` · `axiom.verify` · `axiom.reason` · `axiom.compare` · `axiom.dream` · `axiom.plan` · `axiom.agent` · `axiom.policy` · `axiom.approvals`

```json
{
  "mcpServers": {
    "axiom": {
      "command": "node",
      "args": ["/path/to/axiom/mcpServer.js"]
    }
  }
}
```

---

## LLM Entegrasyonu

### Ollama (önerilen, ücretsiz)

```bash
ollama serve
ollama pull llama3.2:3b
node cli.js
axiom> llm-sor: kedi memeli midir?
```

### OpenAI

```bash
OPENAI_API_KEY=sk-... node cli.js
```

### Paranoid Mod (LLM öğrenmeyi engelle)

```bash
AXIOM_PARANOID=1 node cli.js
```

---

## Mimari

```
kernel.js         — Öğrenme, sorgulama, verify(), learnFromLLM(), nedensellik
kernel.v2.js      — Yapılandırılmış envelope API, manipülasyon tespiti, enhanced verify
graph.js          — Graf motoru + SQLite/JSON çift kalıcılık katmanı
dream.js          — Hipotez motoru (Node2Vec embedding, benzerlik keşfi)
llmAdapter.js     — Ollama + OpenAI wrapper, hata sarmalama
causalSimulator.js — What-if nedensel simülasyon (v0.7)
evidence-ranker.js — Kanıt kalitesi sıralama (user_opinion→replicated)
finalizer.js      — Deterministik özet ve öneri üretimi
agent.js          — Hafif çok adımlı agent runtime
agent.v3.js       — Checkpoint/resume destekli agent
agentRuntime.js   — Agent versiyonu ve runtime seçici
storage.js        — SQLite: checkpoint, hedef hafızası, tool approval
toolPolicy.js     — Araç güvenlik politikası
requestGuards.js  — Girdi doğrulama ve sanitizasyon
plugin.js         — Event-driven plugin sistemi
cli.js            — Türkçe doğal dil parser + async LLM desteği
server.js         — REST API + D3.js interaktif graf arayüzü
mcpServer.js      — MCP stdio sunucu (10 araç)
```

---

## Testler

```bash
npm test              # Tüm testler (468 test)
npm run test:graph
npm run test:kernel
npm run test:cli
npm run test:dream
npm run test:plugin
npm run test:server
npm run test:backup
```

---

## Benchmark

```bash
npm run bench           # Tüm benchmark
npm run bench:verify    # Doğrulama benchmark
```

| Graf boyutu | learn | ask | verify | reason | compare | dream |
|---|---|---|---|---|---|---|
| small | ~50ms | ~0.4ms | ~0.25ms | ~0.4ms | ~0.45ms | ~1.8ms |
| medium | ~44ms | ~0.09ms | ~0.06ms | ~0.26ms | ~0.09ms | ~1.7ms |
| large | ~43ms | ~0.07ms | ~0.03ms | ~0.10ms | ~0.07ms | ~5.6ms |

---

## Hafıza

| Dosya | İçerik |
|---|---|
| `memory.db` | SQLite — graf, checkpoint, agent hafızası, araç onayları (WAL) |
| `memory.json` | JSON yedek — Rust katmanı ve fallback |
| `memory.embeddings.json` | Node2Vec vektörleri (ayrı, şişmeyi önler) |

SQLite varsayılan. Devre dışı: `AXIOM_USE_SQLITE=false`

---

## Plugin Sistemi

`plugins/` klasörüne `.js` dosyası bırak, otomatik yüklenir.

```js
module.exports = {
  name: 'my-plugin',
  init(kernel) {},
  beforeLearn(kernel, data) { /* data.text değiştirilebilir */ },
  afterLearn(kernel, data) {},
  beforeAsk(kernel, data) { /* data.question değiştirilebilir */ },
  afterAsk(kernel, data) {},
  beforeDream(kernel, data) {},
  afterDream(kernel, data) { /* data.hypotheses */ },
  beforeEmbedding(kernel, opts) {},
  afterEmbedding(kernel, result) {},
};
```

---

## Docker

```bash
docker-compose up
```

---

## Ortam Değişkenleri

| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `AXIOM_PARANOID` | `1` → LLM öğrenmeyi engelle | - |
| `AXIOM_AGENT_VERSION` | `v2` veya `v3` | `v2` |
| `AXIOM_AGENT_RUNTIME` | `classic` veya `workflow` | `classic` |
| `AXIOM_KERNEL_VERSION` | `v2` → KernelV2 kullan | - |
| `AXIOM_MEMORY_PATH` | Graf JSON dosyası | `memory.json` |
| `AXIOM_DB_PATH` | SQLite dosyası | `memory.db` |
| `AXIOM_USE_SQLITE` | `false` → JSON'a düş | `true` |
| `OPENAI_API_KEY` | OpenAI API anahtarı | - |

---

## Versiyon

**v0.9.0** — Trust Kernel & AXIOM Trust Protocol, 592 test

*Memory Core (Main Branch Work):*
- [Memory Core v0.9.1](./docs/memory-core-v0.9.1.md)
- [Memory Core Smoke Test](./docs/memory-core-smoke.md)
- [v0.9.1 Release Checklist](./docs/v0.9.1-release-checklist.md)

[CHANGELOG](./CHANGELOG.md) · [ROADMAP](./ROADMAP.md) · [MIT Lisans](./LICENSE)



