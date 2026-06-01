# AXIOM v0.6 SDK Wrappers

Bu doküman, AXIOM çekirdeğini dış AI framework'lerine ince bir wrapper katmanı ile bağlamak için kullanılır.

## Amaç

- AXIOM'u tool/middleware olarak kullanılır hale getirmek
- Mevcut shield ve capability davranışını yeniden yazmadan dışa açmak
- Yeni dependency eklemeden uyum katmanı sağlamak

## Sağlanan Yüzey

### `createAxiomClient(kernel, options)`

Tek giriş noktası:

- `verify(input)`
- `reason(input)`
- `runCapability(name, input, opts)`
- `shield(payload)`
- `toLangChainTool(opts)`
- `toVercelAiMiddleware(opts)`

### `toLangChainTool(kernel, options)`

Plain object döner. LangChain paketi import edilmez.

Desteklenen komutlar:

- `verify`
- `reason`
- `mri` / `ideaMRI`
- `devil` / `devilAdvocate`
- `contradictions` / `contradictionAlert`
- `shield`

### `toVercelAiMiddleware(kernel, options)`

Vercel AI SDK import edilmeden shield benzeri bir middleware factory sağlar.

Çıktı:

- `label`
- `shield`
- `axiomCheck`
- `llmCheck`
- `learnResult`

## Shield Politikası

- `autoLearn` default `false`
- `unsupported` cevaplar otomatik öğrenilmez
- `contradicted` cevaplar otomatik öğrenilmez
- `llm-assisted` cevaplar yalnızca açıkça izin verilirse öğrenilebilir

## LlamaIndex Kararı

LlamaIndex entegrasyonu bu PR kapsamında yoktur.

```txt
LlamaIndex integration is planned but intentionally out of scope for v0.6 PR-5.
```

## Notlar

- `server.js` değişmez
- `public/index.html` değişmez
- `lib/shield.js` davranışı değişmez
- `lib/ingest.js` davranışı değişmez
- Yeni npm dependency eklenmez
