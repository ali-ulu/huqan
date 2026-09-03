# Launch UAT

Bu kontrol listesi, yeni bir geliştiricinin, yatırımcının veya değerlendiricinin AXIOM / HUQAN'ı temiz bir klon üzerinden güvenli biçimde deneyebilmesi için hazırlanmıştır.

## 1. Fresh clone testi

```bash
git clone https://github.com/ali-ulu/huqan.git
cd huqan
git branch --show-current
git status --short
```

Beklenen:

- branch `main`
- çalışma ağacı temiz

## 2. Install komutu

```bash
npm ci --include=optional
node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"
```

Beklenen:

- bağımlılıklar temiz kurulur
- `better-sqlite3 ok` çıktısı alınır

## 3. Test komutu

```bash
npm test
```

Beklenen:

- testler geçer
- zero-fail hedefi korunur

## 4. CLI smoke

```bash
node egitim.js
node cli.js
```

Örnek akış:

- `learn: cats are animals`
- `ask: cat nedir`
- `verify: kedi bitkidir`

Beklenen:

- CLI açılır
- Türkçe ve İngilizce uyumlu örnekler çalışır
- hiçbir komut runtime dışına taşmaz

## 5. Local UI smoke

```bash
node server.js
```

Beklenen:

- yerel backend-connected UI açılır
- `public/index.html` yüzeyi görülür
- demo sayfası ile karışmaz

## 6. Static demo smoke

Beklenen static demo yüzeyi:

- `demo/index.html` (planlanan yüzey; henüz repoda yok — bkz. `docs/product-surfaces.md`)

Beklenen:

- backend bağımlılığı yok
- demo yüzeyi yalnızca statik sunumdur
- public UI ile karıştırılmaz

## 7. API smoke

Örnek güvenli uçlar:

- `GET /api?q=...`
- `POST /verify`
- `POST /dogrula`
- `POST /v2/verify`
- `POST /upload`
- `POST /yukle`

Beklenen güvenli başarısızlıklar:

- `GET /verify` -> `405 Method Not Allowed`
- `GET /dogrula` -> `405 Method Not Allowed`
- `GET /v2/verify` -> `405 Method Not Allowed`

## 8. Expected safe failures

Şunlar blokör sayılmaz:

- `GET` üzerinden guarded verify denemelerinin `405` dönmesi
- demo yüzeyinde backend çağrısı olmaması
- read-only allowlist dışındaki tehlikeli query'lerin reddedilmesi

## 9. What counts as blocker

Şunlar blokördür:

- testlerde fail
- `better-sqlite3` yüklenmemesi
- public GET yüzeyinin guard bypass etmesi
- runtime code drift
- package drift
- dirty root veya runtime artifact oluşması

## 10. What does not count as blocker

Şunlar blokör değildir:

- docs-only PR için full UI revizyonu olmaması
- statik demo ile local UI'nin ayrı olması
- güvenli GET isteklerinin `405` dönmesi
- demo script'in kısa ve kontrollü olması
