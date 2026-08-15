# AXIOM v0.6 Demo Smoke

Bu doküman, v0.6 productization yüzeyini tek akışta doğrulamak için kullanılır.

## Amaç

- Ürün yüzünün açıldığını doğrulamak
- Shield davranışını görmek
- Ingest yüzeyinin çalıştığını görmek
- Graph metadata'nın UI'ya taşındığını doğrulamak
- Demo akışının bozulmadığını hızlıca kontrol etmek

## Ön Koşullar

- Node.js 18+
- `npm install` tamamlanmış olmalı
- Yerel SQLite storage erişilebilir olmalı

## Başlatma

Bir terminalde:

```bash
node server.js
```

Server açıldıktan sonra varsayılan adres:

```bash
http://127.0.0.1:3000
```

## Smoke Akışı

### 1) Health ve status

```bash
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v2-status
curl.exe -H "Authorization: Bearer $HUQAN_API_KEY" http://127.0.0.1:3000/graph-data
```

Beklenen:

- `/health` 200 döner
- `/v2-status` sistem durumunu döner
- `/graph-data` geçerli API anahtarıyla node/link metadata döner; anahtarsız istek 401 alır

### 2) Ana sayfa ve ürün yüzü

```bash
curl.exe http://127.0.0.1:3000/
```

Beklenen:

- `AXIOM cevap vermez. Düşünceni yargılar.`
- `Fikrini Yargılat`
- `Şeytan'ın Avukatı`
- `Geçmiş Çelişkiler`
- `Hafıza / Graph`

### 3) Öğret / sorgu akışı

CLI'da:

```bash
ogret: kedi hayvandir
sor: kedi nedir
mri: AXIOM company brain olmali
tartis: AXIOM company brain olmali
celiski: AXIOM motor degil ana urun olmali
```

Beklenen:

- `ogret` grafa bilgi yazar
- `sor` bildiğini döner, bilmediğinde uydurmaz
- `mri/tartis/celiski` ürün komutları çalışır

### 4) Shield testi

```bash
curl.exe -X POST http://127.0.0.1:3000/llm-sor ^
  -H "Content-Type: application/json" ^
  -d "{\"question\":\"kedi neden uyur?\"}"
```

Beklenen:

- response içinde `label`
- `shield.autoLearn` default `false`
- `contradicted` ve `unsupported` cevaplarda auto-learn yok

### 5) Ingest testi

Manual:

```bash
curl.exe -X POST http://127.0.0.1:3000/api/ingest ^
  -H "Content-Type: application/json" ^
  -d "{\"sourceType\":\"manual\",\"text\":\"AXIOM product demo smoke manual ingest\"}"
```

Decision:

```bash
curl.exe -X POST http://127.0.0.1:3000/api/ingest ^
  -H "Content-Type: application/json" ^
  -d "{\"sourceType\":\"decision\",\"title\":\"v0.6 demo smoke\",\"rationale\":\"productization release flow\"}"
```

Markdown:

```bash
curl.exe -X POST http://127.0.0.1:3000/api/ingest ^
  -H "Content-Type: application/json" ^
  -d "{\"sourceType\":\"markdown\",\"path\":\"README.md\"}"
```

Beklenen:

- ingest route 200 döner
- `manual`, `decision`, `markdown` akışları çalışır
- ingest status güncellenir

### 6) Graph metadata testi

`/graph-data` çıktısında şu alanlar görünmeli:

- node:
  - `confidence`
  - `evidenceCount`
  - `sources`
  - `last_seen`
- link:
  - `confidence`
  - `sourceType`
  - `source`
  - `sourceRef`
  - `evidenceCount`
  - `updatedAt`

## Geçiş Kriteri

Smoke şu durumda geçer:

- HTTP yüzeyleri çalışıyor
- ürün sekmeleri görünür
- Shield label döner
- ingest route yanıt veriyor
- graph metadata UI'ya geliyor
- test suite yeşil kalıyor

## Not

Bu doküman demo/release smoke içindir. Kod davranışını değiştirmez.
