# Launch UAT

Bu kontrol listesi, yeni bir geliÅŸtiricinin, yatÄ±rÄ±mcÄ±nÄ±n veya deÄŸerlendiricinin AXIOM / HUQAN'Ä± temiz bir klon Ã¼zerinden gÃ¼venli biÃ§imde deneyebilmesi iÃ§in hazÄ±rlanmÄ±ÅŸtÄ±r.

## 1. Fresh clone testi

```bash
git clone https://github.com/agiulucom42-del/axiom.git
cd axiom
git branch --show-current
git status --short
```

Beklenen:

- branch `main`
- Ã§alÄ±ÅŸma aÄŸacÄ± temiz

## 2. Install komutu

```bash
npm ci --include=optional
node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"
```

Beklenen:

- baÄŸÄ±mlÄ±lÄ±klar temiz kurulur
- `better-sqlite3 ok` Ã§Ä±ktÄ±sÄ± alÄ±nÄ±r

## 3. Test komutu

```bash
npm test
```

Beklenen:

- testler geÃ§er
- zero-fail hedefi korunur

## 4. CLI smoke

```bash
node egitim.js
node cli.js
```

Ã–rnek akÄ±ÅŸ:

- `learn: cats are animals`
- `ask: cat nedir`
- `verify: kedi bitkidir`

Beklenen:

- CLI aÃ§Ä±lÄ±r
- TÃ¼rkÃ§e ve Ä°ngilizce uyumlu Ã¶rnekler Ã§alÄ±ÅŸÄ±r
- hiÃ§bir komut runtime dÄ±ÅŸÄ±na taÅŸmaz

## 5. Local UI smoke

```bash
node server.js
```

Beklenen:

- yerel backend-connected UI aÃ§Ä±lÄ±r
- `public/index.html` yÃ¼zeyi gÃ¶rÃ¼lÃ¼r
- demo sayfasÄ± ile karÄ±ÅŸmaz

## 6. Static demo smoke

Beklenen static demo yÃ¼zeyi:

- `demo/index.html`

Beklenen:

- backend baÄŸÄ±mlÄ±lÄ±ÄŸÄ± yok
- demo yÃ¼zeyi yalnÄ±zca statik sunumdur
- public UI ile karÄ±ÅŸtÄ±rÄ±lmaz

## 7. API smoke

Ã–rnek gÃ¼venli uÃ§lar:

- `GET /api?q=...`
- `POST /verify`
- `POST /dogrula`
- `POST /v2/verify`
- `POST /upload`
- `POST /yukle`

Beklenen gÃ¼venli baÅŸarÄ±sÄ±zlÄ±klar:

- `GET /verify` -> `405 Method Not Allowed`
- `GET /dogrula` -> `405 Method Not Allowed`
- `GET /v2/verify` -> `405 Method Not Allowed`

## 8. Expected safe failures

Åunlar blokÃ¶r sayÄ±lmaz:

- `GET` Ã¼zerinden guarded verify denemelerinin `405` dÃ¶nmesi
- demo yÃ¼zeyinde backend Ã§aÄŸrÄ±sÄ± olmamasÄ±
- read-only allowlist dÄ±ÅŸÄ±ndaki tehlikeli query'lerin reddedilmesi

## 9. What counts as blocker

Åunlar blokÃ¶rdÃ¼r:

- testlerde fail
- `better-sqlite3` yÃ¼klenmemesi
- public GET yÃ¼zeyinin guard bypass etmesi
- runtime code drift
- package drift
- dirty root veya runtime artifact oluÅŸmasÄ±

## 10. What does not count as blocker

Åunlar blokÃ¶r deÄŸildir:

- docs-only PR iÃ§in full UI revizyonu olmamasÄ±
- statik demo ile local UI'nin ayrÄ± olmasÄ±
- gÃ¼venli GET isteklerinin `405` dÃ¶nmesi
- demo script'in kÄ±sa ve kontrollÃ¼ olmasÄ±