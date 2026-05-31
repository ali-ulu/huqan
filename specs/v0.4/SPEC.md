# SPEC - AXIOM v0.4 Company Brain

## Introduction

AXIOM v0.4, bireysel dusunce yargilamadan sirket hafizasina gecer.
Bir repo, Markdown dokumani veya manuel not AXIOM'a kaynak olarak verildiginde
AXIOM bu icerigi bilgi grafina ogrenir ve sirket/proje kararlarini sorgulayabilir.

Temel ilke:
- Kaynak ne olursa olsun ayni `graph + kernel` calisir.
- Yeni katman `ingest` katmanidir.

## Scope

Bu surumun zorunlu kapsami:
1. `companyMode` capability
2. `repo-memory` plugin
3. `markdown-adapter`
4. manuel ingest
5. `company-brain` query
6. decision log
7. ingest durumu ve raporlama

Yeni dosyalar:
- `adapters/github-adapter.js`
- `adapters/markdown-adapter.js`
- `plugins/repo-memory.js`
- `plugins/company-brain.js`

Kritik kural:
- Octokit YASAK.
- Sifir dependency prensibi korunur.
- GitHub erisimi native `fetch` ile yapilir.

## Requirement 1 - Company Mode Capability

### User Story
Gelistirici olarak AXIOM'u sirket/proje modu icin acikca etkinlestirmek istiyorum.

### Acceptance Criteria
1. `kernel.enableCapability("companyMode")` cagrildiginda company mode aktif olur ve `capability:enabled` eventi yayinlanir.
2. Company mode aktifken `learn()` cagrilarinda edge metadata'sina `companyMode: true` ve `sourceType` (`repo|markdown|manual`) eklenir.
3. Company mode kapaliyken `repo-memory` veya `company-brain` plugin'i yuklenemez; aciklayici log yazilir.
4. `listCapabilities()` cikisinda `companyMode` gorunur.

## Requirement 2 - Repo Memory Plugin

### User Story
Bir GitHub reposunu AXIOM'a kaynak verip dosya/karar baglamini sorgulamak istiyorum.

### Acceptance Criteria
1. Plugin GitHub URL aldiginda su kaynaklari ingest eder: `README.md`, `CONTRIBUTING.md`, `ROADMAP.md`, root Markdown dosyalari, `.github/` altindaki dokumanlar.
2. Her dosya `source_ref` ile ogrenilir: `repo:<owner>/<name>:<path>`.
3. Temporal aktifse `created_at` olarak GitHub `last_modified` kullanilir, degilse ingest zamani kullanilir.
4. Ayni dosya ikinci kez ingest edilirse duplicate olusmaz, mevcut node/edge guncellenir.
5. Plugin tanimi: `requires=["graph","companyMode"]`, `optional=["llm","temporal","evidenceRanking"]`.
6. Rate limit asiminda ingest durur, hata loglanir, surec crash etmez.

## Requirement 3 - Markdown Adapter

### User Story
Lokal Markdown belgelerini GitHub'a yuklemeden ingest etmek istiyorum.

### Acceptance Criteria
1. Klasor girdisinde tum `.md` dosyalari recursive taranir.
2. Markdown `#`, `##`, `###` basliklarina gore bolumlenir.
3. Bolum `source_ref` formati: `file:<absolutePath>:<sectionTitle>`.
4. Tekrar ingestte sadece degisen bolumler guncellenir.
5. Adapter GitHub adapter'dan bagimsiz calisir.

## Requirement 4 - Manual Ingest

### User Story
Serbest metin notu kaynak metadata ile AXIOM'a ogretmek istiyorum.

### Acceptance Criteria
1. `company-brain` plugin'i `{ sourceType: "manual", author, date }` opsiyonlariyla metni ingest eder.
2. `source_ref` formati: `manual:<author>:<date>`.
3. `evidenceRanking` aciksa `evidenceType="user_experience"` atanir ve `adjustedConfidence` hesaplanir.
4. CLI komutu desteklenir: `axiom ogren --kaynak manuel --yazar <ad> "<metin>"`.

## Requirement 5 - Company Brain Query

### User Story
"Bu dosya neden var?" ve "Bu karar neden alindi?" gibi sorulari AXIOM'a sorabilmek istiyorum.

### Acceptance Criteria
1. Soru geldiginde once graph tabanli arama yapilir.
2. Graph yeterliyse cevap `source_ref` listesiyle doner, LLM kullanilmaz.
3. Graph yetersiz ve LLM acik ise cevap `source: "llm+graph"` etiketiyle doner.
4. Graph yetersiz ve LLM kapali ise ilgili `source_ref` listelenir, manuel inceleme onerilir.
5. Destekli soru tipleri:
   - "Bu dosya ne icin?"
   - "Bu karar neden alindi?"
   - "PR X ile hangi karar celisiyor?"
   - "Teknik borc nereden geliyor?"
6. Plugin tanimi: `requires=["graph","companyMode"]`, `optional=["llm","temporal","evidenceRanking","contradictionDetection"]`.

## Requirement 6 - Decision Log

### User Story
Kararlari gerekcesiyle kaydedip ileride nedensellik sorgusu yapmak istiyorum.

### Acceptance Criteria
1. `{ type: "decision", title, rationale, alternatives, decidedBy, date }` girdisi decision node olarak kaydedilir.
2. Decision node ilgili dosya/PR node'lariyla `relation: "decides"` kenari ile baglanir.
3. `contradictionDetection` aciksa yeni karar mevcut kararlarla celiski kontrolune girer.
4. CLI komutu desteklenir:
   - `axiom ogren --kaynak karar --baslik "<baslik>" --gerekce "<gerekce>"`.

## Requirement 7 - Ingest Status

### User Story
Ingest edilen kaynaklarin dagilimini ve hata durumunu gormek istiyorum.

### Acceptance Criteria
1. `kernel.runCapability("ingestStatus")` su bilgileri dondurur:
   - toplam node sayisi
   - `repo/markdown/manual` dagilimi
   - son ingest tarihi
   - basarisiz ingest listesi
2. REST endpoint:
   - `GET /api/ingest/status`
3. Basarisiz ingestler `ingestErrors` listesinde saklanir ve basarili ingestte otomatik silinmez.

## Design

### Mimari Degisim Haritasi

```
kernel.js
  - companyMode capability ve sourceType metadata

adapters/
  - github-adapter.js      (native fetch, no Octokit)
  - markdown-adapter.js

plugins/
  - repo-memory.js
  - company-brain.js

server.js
  - GET /api/ingest/status
  - POST /api/ingest

cli.js
  - kaynak: github / markdown / manuel / karar
```

### Adapter Contracts

```js
// adapters/github-adapter.js
async function fetchRepoFiles(repoUrl, opts = {}) {
  // opts: { token, branch, paths }
  // return: [{ path, content, lastModified }]
}
```

```js
// adapters/markdown-adapter.js
function parseMarkdown(content, filePath) {
  // return: [{ sectionTitle, content, level, filePath }]
}
```

## Task Plan

1. Task 1 - `companyMode` capability (`kernel.js` + test)
2. Task 2 - `adapters/github-adapter.js` + test (mock fetch)
3. Task 3 - `adapters/markdown-adapter.js` + test
4. Task 4 - `plugins/repo-memory.js` + test
5. Task 5 - `plugins/company-brain.js` + test
6. Task 6 - `server.js` ingest endpoints + test
7. Task 7 - `cli.js` company ingest komutlari + test
8. Task 8 - tam regresyon + `v0.4.0` etiketleme

## Dependency Order

`companyMode -> adapters -> repo-memory -> company-brain -> API/CLI -> regression`

## Estimated Effort

Toplam efor: ~13 saat
- companyMode: ~0.5 saat
- github-adapter: ~2 saat
- markdown-adapter: ~1 saat
- repo-memory: ~3 saat
- company-brain: ~4 saat
- API/CLI: ~2 saat
- regression/docs: ~0.5 saat
