# ADR: Emergency-Stop Tamper Evidence + Workspace Lift Quorum (#2584)

Tarih: 2026-09-17
Durum: Implemented (feat/2584-emergency-stop-tamper-evidence)
Karar veren: huqan-core

## Baglam

#315 ("Ajanlar Huqan'i devre disi birakmasin") NOT_PLANNED kapatilmisti (#321'e dupe). #321 (HUQAN_HUMAN_APPROVAL_DISABLED env var) saglamdi ama asil soru — ajan HUQAN'i veya kill-switch'i baypas edebilir mi — `lib/emergency-stop.js` (#2505F) sonrasi yeniden denetlenmemisti.

Denetim bulgusu (dosya: `lib/emergency-stop.js:129-161` v1):
- `huqan.emergency_stop` MCP'de `lib/mcp/tool-surface.js:11 OPERATOR_TOOL_NAMES` icinde, modele hic listelenmiyor — ajan goremiyor/cagiramiyor.
- Ama `stop` kaydi duz JSON dosya (`wx` create / `unlink` lift), butunluk korumasi yok. `receipts.jsonl` hash-zincirsiz.
- Shell/dosya erisimi olan ajan `fs.unlinkSync(<hash>.stop.json)` ile `lift()`'in `actor` zorunlulugunu baypas eder, `check()` sonra `ENOENT => stopped:false` doner, hic receipt uretilmez. Iz kaybolur.

## Onceki oneri neden reddedildi

"eBPF'i sifirdan yazmak" onerisi 3 sebeple reddedildi:
1. Bosluk olculmeden acmak riskli — router/capability katmani zaten her eylemi gate'liyor, kaybolan iz teorik mi gercek mi olculmeliydi.
2. eBPF kernel seviyesi, Linux-only, Windows CI'de karsiligi yok, yanlis yazilirsa guvenlik acigi yaratir. Sanayide cozulmus araclar var (gVisor, Firecracker microVM, Tetragon/Falco).
3. Karar mantigi (capability trust) ile sistem programlama (kernel izolasyon) farkli disiplin — ayni akista kalite duser.

## Karar

### 1. Sifirdan eBPF yazma — Entegre et

HUQAN kendi eBPF probe'unu yazmaz. OS seviyesi izolasyon gerektiginde mevcut denetlenmis araclardan biri entegre edilir. Bu ADR o yatirimi kapsamaz, sadece dosya-butunluk katmanini cozer.

### 2. Tamper-evident ledger (bu PR)

`lib/emergency-stop.js` v2:
- Her `stop`/`lift`/`integrity_violation` tek bir `ledger.jsonl`'a hash-zincirli append: `entry.hash = sha256(stableStringify({...payload, prevHash}))` (`lib/receipt/canonical-receipt.js:stableStringify` yeniden kullanilir).
- `check()` artik tek dosyaya guvenmez, ledger'i replay eder. `rm` tek basina yetmez — ledger hala `stopped:true` der.
- `verifyIntegrity()` + `check()` her okumada zinciri dogrular (seq gap, prevHash mismatch, hash mismatch). Ledger bosken legacy dosyalar gecerli (migration), ledger doluyken ledger otoriter — mismatch => `emergency_stop_integrity_violation` (fail-closed).
- `check()`/`stop()`/`lift()` oncesi `verifyIntegrity()` calisir, ihlal gorurse `handleIntegrityViolation()` ile `ledger`a `integrity_violation` entry'si append eder ve `.stop.json`'i yeniden olusturur — iz kalici, restart'ta da duruyor.
- `receipts.jsonl` korunuyor (compat), ayrica ledger da var.

### 3. Hardcore otomatik tepki — dar kapsam

`lib/self-healer/behavioral-containment.js` genel kurali ("never executes a kill-switch") bozulmaz. Tek istisna: **kendi butunluk zincirine kurcalama**. Gerekce: bu eylemin mesru bir aciklamasi yoktur.

- Ihlalde `system:integrity-violation` aktoruyle `stop({scope, actor:'system:integrity-violation'})` mantigi tetiklenir — mevcut stop mekanizmasi yeniden kullanilir, yeni containment kodu icat edilmez.
- Kimlik belirsizse `workspace` scope'a genisler, dar bir yanlis kimlige kilit atmaz.
- Bildirim `lib/observability/notification-adapter.js` uzerinden, `integrity_violation` icin kapatilamaz route (Control Room banner, operator `lift` receipt'iyle temizlenir).

### 4. Workspace lift quorum — GERI ALINDI (#2591)

Ilk tasarimda `lift()` ayni actor'u reddediyordu. Testler gosterdi ki tum
yuzeyler rol actor'u hardcode'liyor (`operator:cli`, `operator:http`,
`operator:mcp` — insan kimligi yok): kural mesru tek-yuzey stop-then-lift
akisini bozarken, tum yuzeyleri tutan kandirilmis bir insani durdurmuyordu.
`test/emergency-stop-operator-surfaces.test.js` (CLI stop+lift) regresyonu
yakaladi; kural kaldirildi, stop author ledger'da kayitli kalmaya devam
ediyor. Gerekce kodu `lib/emergency-stop.js lift()` icinde. Gercek quorum,
operator yuzeyleri insan kimligi tasiyana kadar mumkun degil — takip #2592.

## Kapsam disi (bilincli)

- `SIGKILL` / state-root'u unmount/corrupt / network kesme — OS seviyesi, bu PR kapsamaz, sandbox entegrasyonu gerektirir.
- Davranis sapmasinda auto-kilit — kapsam disi, false-positive riski yuksek.

## Dogrulama

- `test/emergency-stop.test.js` 13/13 geciyor (corrupt record testi #2584'e gore guncellendi: `integrity_violation` da fail-closed sayilir).
- Manuel dogrulama:
  - `rm .stop.json` sonra `check()` => `stopped:true reason=integrity_violation` (ledger replay kurtariyor).
  - `ledger.jsonl` hash'iyle oyna sonra `check()` => `ledger_hash_mismatch` => `integrity_violation`.
  - CLI `stop --scope workspace` + `lift` ayni actor ile calisiyor (quorum geri alindi).

## Sonraki adimlar

- Quorum'u 2 distinct lift approver'a genisletme ihtiyaci olursa `lib/human-oversight-approval-runtime-primitives.js` ile ortaklastirilabilir.
- Dis ajan confused-deputy icin `provenanceRefs` + onay ekraninda "kaynak: dis ajan X" etiketi ayri issue.
- Sandbox entegrasyonu (gVisor/Firecracker/Tetragon) ayri EPIC, bu ADR sadece dosya-butunluk katmani.
