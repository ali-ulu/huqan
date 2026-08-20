# Inline Enforcement Matrix

```text
giris (claim / tool call / memory mutation / connector action)
        ↓
gate enforcement (AB1..AB6 + tool/memory/connector gecitleri)
        ↓
karar (allow / review / block / dry_run_only)
        ↓
risk + metadata + (gerektiginde) receipt / audit
```

## Amac

`partial trust layer` siniflandirmasini makine-okunur ve dogrulanabilir hale
getirir. Mevcut gate'lerin her trust-connected yüzeyde tutarli sekilde
enforcement üretip üretmedigini ve **bilinmeyen/mutating girislerin asla
izinsiz (allow) cikmamasini** (fail-closed) dogrular.

Bu belge enforcement matrisinin test sözlesmesini tutar. Runtime connector
uygulamasi matrisin kendisinde degil, onu kullanan bounded adapter'da tutulur:
`lib/connector-action-firewall.js`.

## Test Dosyasi

- `test/inline-enforcement-matrix.test.js`
- `test/connector-action-firewall.test.js`
- `plugins/repo-memory.test.js`
- `cli.test.js`

## Invariant'lar

1. Her matrix satiri `ok`, gecerli bir `decision`, `reason`, `risk` ve
   `metadata` üretmelidir.
2. `allowExpected = true` yalnizca `allowed === true` ve `canExecute === true`
   olarak döner (düsük riskli okuma yollari).
3. **Fail-closed**: `allowExpected = false` satirlar (write, destructive,
   agent-loop, bilinmeyen, malformed) asla `allow` dönemez.
4. Bilinmeyen MCP araci `block` döner.
5. Malformed MCP girisi asla `allow` dönemez.
6. Kritik risk tool-call-gate üzerinde asla `allow` degildir.
7. Kayitli tüm MCP araclari gecerli karar üretir (adapter version ile).
8. Secret token warning/reason'a sizmaz.
9. Mutating yüzeyler her zaman denetimli (guarded) döner.
10. Connector executor, firewall karari `allow` ve `canExecute` olmadikça
    cagrilamaz.
11. Connector preview ve dry-run istekleri `dry_run_only` olarak kalir; remote
    fetch veya graph ingest baslatamaz.
12. Connector target normalizasyonu basarisizsa adapter canonicalizer'a göre
    bounded bir block reason döndürür ve executor'a ulasmaz.

## #968 GitHub Connector Slice

Ilk production caller, CLI tarafindaki `company-ingest` GitHub/repo yoludur.
CLI bu yolu açik opt-in ile `repoMemory` capability'sine aktarir:
`enforceConnectorFirewall: true`.

`repoMemory` içinde `sourceType: github` ve bu opt-in birlikte geldiginde
remote `fetchRepoFiles` cagrisi asagidaki sirayla ilerler:

```text
repoUrl
  ↓
canonicalizeGitHubRepoUrl
  ↓
connector-action-firewall
  ↓ allow + canExecute
fetchRepoFiles
  ↓
repo-memory admission / kernel.proposeNode + kernel.proposeEdge
```

Connector adapter yalnizca `github.ingest` action'ini `github.read_repository`
olarak mevcut Agent Action Firewall'a map eder. Adapter yeni bir signer,
receipt family veya durability otoritesi olusturmaz. Graph yazimi mevcut
repo-memory admission ve canonical Kernel yüzeyinde kalir.

Malformed target, bilinmeyen connector/action, preview, dry-run ve firewall
allow disi kararlar remote fetch'i durdurur. Varsayilan migration boundary
korunur: `repoMemory` dogrudan cagrilarinda connector enforcement ancak
`enforceConnectorFirewall: true` ile etkinlesir; CLI GitHub production yolu bu
opt-in'i açikça verir.

## Kaynak

- `docs/audits/connector-trust-coverage-inventory.md` — yüzey siniflandirmasi
- `docs/agent-action-firewall.md` — action/target/approval sözlesmesi
- `lib/agent-action-firewall.js` — canonical Agent Action Firewall
- `lib/connector-action-firewall.js` — bounded connector adapter
- `plugins/repo-memory.js` — GitHub production caller
- `cli.js` — GitHub/repo ingest CLI ingress'i
- Gate'ler: `lib/tool-call-gate.js`, `lib/memory-mutation-gate.js`,
  `lib/mcp-gate-adapter.js`

## Sinir (Boundary)

- Matris dosyasi test sözlesmesidir; runtime davranisini adapter ve production
  caller dosyalari uygular.
- Bu slice yalnizca GitHub repository read/fetch → repo-memory ingest yolunu
  kapsar. Commit, push, merge, release, deploy veya baska connector aileleri
  bu degisikligin kapsaminda degildir.
- Connector fetch'in `allow` karari graph mutation izni degildir; ingest'in
  kendi admission/provenance/receipt kapilari ayrica uygulanir.
- Yeni bir connector yüzeyi eklenirken matrise ve production-shaped
  integration testlerine satir eklenmesi zorunludur (CI'da fail-closed).
