# Inline Enforcement Matrix (fail-closed)

```text
giris (claim / tool call / memory mutation)
        ↓
gate enforcement (AB1..AB6 + tool/memory gecitleri)
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

Bu matris **test-only** bir katmandir; hicbir runtime/kernel/persistence
dosyasina dokunmaz.

## Test Dosyasi

- `test/inline-enforcement-matrix.test.js`

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

## Kaynak

- `docs/audits/connector-trust-coverage-inventory.md` — yüzey siniflandirmasi
- Gate'ler: `lib/tool-call-gate.js`, `lib/memory-mutation-gate.js`,
  `lib/mcp-gate-adapter.js`

## Sinir (Boundary)

- Yalniz test altyapisi; runtime davranis degisikligi veya yeni connector yok.
- Yeni bir yüzey eklenirken matrise satir eklenmesi zorunludur (CI'da fail-closed).
