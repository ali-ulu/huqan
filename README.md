# ◇ AXIOM

> **English:** A symbolic AI reasoning engine that works without
> LLMs, GPUs, or cloud. Learns from natural language,
> verifies LLM outputs, detects contradictions, and generates
> hypotheses autonomously. Zero external dependencies.

Türkçe doğal dil ile çalışan, kendi kendine öğrenen bilgi grafiği motoru.

LLM yanıtlarını doğrular, çelişkileri tespit eder ve kişisel hafıza katmanı olarak çalışır. Ollama veya OpenAI ile entegre olur, öğrenilen bilgileri SQLite'ta kalıcı olarak saklar.

---

## Hızlı Başlangıç

```bash
# 1. Bağımlılıkları kur
npm install

# 2. Başlangıç bilgi tabanını yükle
node egitim.js

# 3. CLI ile konuş
node cli.js

# 4. Web arayüzü (http://localhost:3000)
node server.js
```

Node.js >= 18 gereklidir.

---

## Komutlar

### Temel

| Komut | Açıklama |
|---|---|
| `kedi hayvandır` | Bilgi öğret |
| `kedi nedir` | Soru sor |
| `sor: kedi nedir` | Açık soru komutu |
| `öğret: kedi balık yer` | Açık öğret komutu |
| `neden tavuk` | Sebep-sonuç analizi |
| `tavuk mu yumurta mı` | İki kavramı karşılaştır |

### Sistem

| Komut | Açıklama |
|---|---|
| `durum` / `nasılsın` | Düğüm/kenar sayısı, entropi, çelişkiler |
| `rüya` | Hipotez üret (benzerlik, zincir, simetri) |
| `açık düşün` | Arka planda otomatik hipotez üretimi başlat |
| `dur düşünme` | Otomatik düşünmeyi durdur |
| `optimize` | Zayıf kenarları buda, eski düğümleri temizle |
| `kaydet` | Hafızayı diske yaz |
| `çıkış` / `bb` | Çıkış (otomatik kaydeder) |

### LLM & Belge

| Komut | Açıklama |
|---|---|
| `llm-sor: soru` | LLM'ye sor → AXIOM doğrula → otomatik öğren |
| `yükle: dosya.txt` | `.txt` veya `.md` dosyasından öğren |

---

## LLM Entegrasyonu

AXIOM, Ollama (local, ücretsiz) ve OpenAI ile çalışır.

### Ollama (önerilen)

```bash
# Ollama kur: https://ollama.com
ollama serve
ollama pull llama3.2:3b

node cli.js
axiom> llm-sor: kedi memeliler sınıfına girer mi?
```

`llm-sor:` komutu şu adımları otomatik yapar:
1. AXIOM'un mevcut bilgisiyle ön doğrulama
2. LLM'ye soru gönder
3. LLM yanıtını AXIOM ile çapraz doğrula
4. Çelişki yoksa yanıtı otomatik hafızaya ekle

### OpenAI

```bash
OPENAI_API_KEY=sk-... node cli.js
```

---

## REST API

Sunucu `node server.js` ile başlatılır.

### Sohbet

```
GET /api?q=kedi+nedir
→ { "result": "💬 kedi hayvan" }
```

### Doğrulama

```
GET  /dogrula?statement=kedi+hayvandır
POST /dogrula  { "statement": "kedi hayvandır" }
→ { "status": "dogrulandi", "confidence": 0.9, "evidence": [...] }
```

Olası `status` değerleri: `dogrulandi` · `celiski` · `bilinmiyor`

---

## Core API Contract

AXIOM v2 core methods (`learn`, `ask`, `verify`, `reason`, `compare`, `dream`) return the same structured envelope. The current contract version is `1.0.0`:

```js
{
  ok: true,
  type: "verify",
  data: { status: "dogrulandi", confidence: 0.9 },
  evidence: [
    {
      kind: "direct_edge",
      text: "kedi --[t\u00fcr]--> hayvan",
      confidence: 0.9,
      nodes: ["kedi", "hayvan"],
      edges: [{ from: "kedi", to: "hayvan", relation: "t\u00fcr" }]
    }
  ],
  error: null,
  meta: {}
}
```

CLI and legacy REST endpoints keep their user-facing output stable; the structured contract is for code that imports `Kernel` directly.

### Paranoid Mode

`paranoidMode` disables `learnFromLLM` and any external LLM-backed learning path while keeping local symbolic reasoning active.

## MCP Adapter

AXIOM also exposes a minimal stdio-based MCP server for tool-driven clients:

```bash
npm run mcp
```

Available tools:
- `axiom.learn`
- `axiom.ask`
- `axiom.verify`
- `axiom.reason`
- `axiom.compare`
- `axiom.dream`

The adapter returns both human-readable `content` and structured MCP `structuredContent` so clients can choose the format they prefer.

Set `AXIOM_KERNEL_VERSION=v2` to expose the newer `KernelV2.verify` behavior through MCP. The `axiom.verify` output schema includes v2.1 fields such as `inferred`, `reasoningPath`, `pathLength`, `confidenceSource`, and `contradictionReason`.

The same flag also enables `KernelV2` for CLI and REST flows:

```bash
AXIOM_KERNEL_VERSION=v2 node cli.js
AXIOM_KERNEL_VERSION=v2 node server.js
```

## Benchmarks

Run deterministic local performance checks with:

```bash
npm run bench
```

Fixture sizes live under `benchmarks/fixtures/` and are intentionally stable so results can be compared across commits.

## Release Notes

For the current v2 shipping status and next-phase priorities, see [RELEASE_V2.md](./RELEASE_V2.md), [ROADMAP_V2.md](./ROADMAP_V2.md), [RELEASE_NOTES_v2.0.0.md](./RELEASE_NOTES_v2.0.0.md), and [PUBLIC_RELEASE_POST.md](./PUBLIC_RELEASE_POST.md).

## V2 Status (Single View)

- Phase 1 Core Contract: done
- Phase 2 MCP Polish: done
- Phase 3 Benchmark Regression: done
- Phase 4 Packaging/Docs: done
- v2.1 Verify Reasoning: done
- v2.2 MCP Schema Reflection: done
- v2.3 CLI/REST Runtime: done
- v2.4 Status Dashboard: done
- Test status: `157/157`

## Benchmark Baseline

Committed benchmark summaries live in [benchmarks/results.json](./benchmarks/results.json). The regression workflow compares fresh runs against that baseline on every push to `main`.

### Belge Yükleme

```
POST /yukle  { "text": "kedi hayvandır\nköpek memelidir" }
→ { "ok": true, "learned": 2 }
```

Maksimum 1 MB. Yükleme sonrası otomatik kaydedilir.

### LLM Soru

```
POST /llm-sor  { "question": "kedi nedir?", "autoLearn": true }
→ {
    "ok": true,
    "llmAnswer": "...",
    "axiomCheck": { "status": "dogrulandi", ... },
    "llmCheck":   { "status": "bilinmiyor", ... },
    "learnResult": { "learned": 3, "skipped": 1, "conflicts": [] }
  }
```

### Graf Verisi

```
GET /graph-data
→ { "nodes": [...], "links": [...] }
```

Web arayüzündeki Graf sekmesi bu endpoint'i kullanır.

---

## Web Arayüzü

`http://localhost:3000` adresinde iki sekme bulunur:

**Sohbet** — Tüm CLI komutlarını web üzerinden kullan.

**Graf** — D3.js force-directed interaktif görselleştirme.
- Düğüm büyüklüğü kenar sayısına göre ölçeklenir
- Renk kodlaması: `tür` mor · `yapabilir` cyan · `benzer` yeşil · `özellik` turuncu · `hipotez` kırmızı kesikli
- Düğüme tıkla → kenar listesi paneli açılır
- Sürükle, zoom, etiket toggle

---

## Testler

```bash
# Tüm testler (106 test)
npm test

# Modül bazlı
npm run test:graph
npm run test:kernel
npm run test:cli
npm run test:dream
npm run test:plugin
node --test llmAdapter.test.js
```

---

## Mimari

```
kernel.js        — Öğrenme, sorgulama, çıkarım, verify(), learnFromLLM()
graph.js         — Graf veri yapısı + SQLite/JSON çift katman
dream.js         — Hipotez motoru (node2vec embedding, benzerlik keşfi)
llmAdapter.js    — Ollama + OpenAI wrapper ({ ok, data, error })
plugin.js        — Event-driven plugin sistemi
cli.js           — Doğal dil parser + async LLM desteği
server.js        — HTTP API + D3.js graf arayüzü + rate limiting
rustGraph.js     — Rust binary köprüsü (opsiyonel hızlandırıcı)
egitim.js        — Başlangıç eğitim verisi (mantık, felsefe, bilim)
```

---

## Hafıza

| Dosya | İçerik |
|---|---|
| `memory.db` | SQLite — düğümler + kenarlar (WAL modu, crash-safe) |
| `memory.json` | JSON yedek — Rust katmanı ve fallback için |
| `memory.embeddings.json` | Node2Vec vektörleri (ayrı tutulur, şişmeyi önler) |

SQLite varsayılan olarak aktif. Devre dışı bırakmak için:

```js
const g = new Graph({ useSQLite: false });
```

---

## Plugin Sistemi

`plugins/` klasörüne `.js` dosyası bırak, otomatik yüklenir.

```js
// plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  init(kernel) { /* başlangıç */ },
  beforeLearn(kernel, data) { /* data.text değiştirilebilir */ },
  afterLearn(kernel, data) { /* öğrenme sonrası */ },
  beforeAsk(kernel, data) { /* data.question değiştirilebilir */ },
  afterAsk(kernel, data) { /* data.answer okunabilir */ },
  beforeDream(kernel, data) { },
  afterDream(kernel, data) { /* data.hypotheses */ },
  beforeEmbedding(kernel, opts) { /* opts.dimensions değiştirilebilir */ },
  afterEmbedding(kernel, result) { },
};
```

---

## Rust Hızlandırıcı (Opsiyonel)

`axiom-core/` dizininde Rust ile yazılmış bir graf motoru bulunur. Rust binary varsa otomatik kullanılır, yoksa JS katmanına düşer.

```bash
# Windows cross-compile
cd axiom-core
cargo build --release --target x86_64-pc-windows-gnu
```

---

## Gereksinimler

- Node.js >= 18
- `better-sqlite3` (npm ile otomatik kurulur)
- Ollama (opsiyonel, local LLM için)
- Rust toolchain (opsiyonel, hızlandırıcı için)
