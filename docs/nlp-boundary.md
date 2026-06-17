# NLP Boundary

AXIOM'in mevcut `nlp/lang-tr.js` katmanÄ± bir **simple deterministic parser** olarak Ã§alÄ±ÅŸÄ±r. AmaÃ§, kontrollÃ¼ ifadeleri kÃ¼Ã§Ã¼k ve tekrar Ã¼retilebilir parÃ§alara ayÄ±rmaktÄ±r. Bu katman bir genel amaÃ§lÄ± TÃ¼rkÃ§e NLP motoru deÄŸildir.

## Current scope

- Girdi metnini boÅŸluklara gÃ¶re parÃ§alar.
- TÃ¼rkÃ§e karakterleri ve bazÄ± basit Ã§oÄŸul eklerini normalize eder.
- Basit stop-word filtresi uygular.
- Ã‡oÄŸu durumda ilk anlamlÄ± token'Ä± subject olarak kabul eder.
- `X ve Y ...` gibi Ã§ok sÄ±nÄ±rlÄ± birleÅŸik Ã¶rneklerde iki fact Ã¼retebilir.
- Bilinen node listesi verilirse ilk parÃ§ada subject eÅŸleÅŸmesi arar.

## Current non-goals

- Tam TÃ¼rkÃ§e morfoloji Ã§Ã¶zÃ¼mlemesi
- Ã‡ok cÃ¼mleli metinleri gÃ¼venilir biÃ§imde ayÄ±rma
- KarmaÅŸÄ±k bileÅŸik iddialarÄ± Ã§Ã¶zme
- Gizli baÄŸlam, kinaye veya dolaylÄ± anlatÄ±m Ã§Ã¶zÃ¼mÃ¼
- Genel amaÃ§lÄ± semantik anlama
- Hukuki, tÄ±bbi veya havacÄ±lÄ±k metinlerinde uzman parser davranÄ±ÅŸÄ±

## Safe public language

Kamuya aÃ§Ä±k anlatÄ±mda ÅŸu ifadeler gÃ¼venlidir:

- "simple deterministic parser"
- "best for controlled statements"
- "not a full Turkish NLP engine"
- "domain parsers should be optional adapters"
- "complex legal/medical/aviation text requires explicit modeling or specialized parser"

KaÃ§Ä±nÄ±lmasÄ± gereken ifadeler:

- "understands Turkish"
- "general NLP"
- "production-grade semantic parser"
- "can parse arbitrary natural language"
- "legal/medical ready parser"

## Parser vs verifier

Parser ve verifier aynÄ± ÅŸey deÄŸildir.

- Parser, girdi metnini claims / subclaims / entities / relations gibi yapÄ±lara ayÄ±rÄ±r.
- Verifier, bu yapÄ±larÄ± graph, trust ve semantic signals Ã¼zerinde deÄŸerlendirir.

Parser'Ä±n Ã¼retmesi gereken ÅŸey, doÄŸrulanabilir bir ara yapÄ±dan ibarettir. Canonical memory'ye otomatik kabul yapmamalÄ±dÄ±r.

## Safe examples

Bu tÃ¼r ifadeler mevcut parser iÃ§in uygundur:

- `kedi hayvandÄ±r`
- `beta bir sistemdir`
- `axiom ve huqan aynÄ± ÅŸey deÄŸildir`
- `kedi bitkidir`

Bu Ã¶rneklerde Ã§Ä±ktÄ±, kontrollÃ¼ ve kÄ±sa bir iddia kalÄ±bÄ± olarak dÃ¼ÅŸÃ¼nÃ¼lmelidir.

## Unsafe or ambiguous examples

Bu tÃ¼r girdiler gÃ¼venilir parse iÃ§in uygun deÄŸildir:

- Ã‡ok cÃ¼mleli anlatÄ±mlar
- Birden fazla iddiayÄ± tek paragrafta karÄ±ÅŸtÄ±ran metinler
- Hukuki, tÄ±bbi veya havacÄ±lÄ±k dili
- Ä°ma, ironi, kinaye, alÄ±ntÄ± iÃ§ iÃ§eliÄŸi
- Uzun ve bileÅŸik karÅŸÄ±laÅŸtÄ±rmalar
- `A ve B ...` dÄ±ÅŸÄ±nda kalan karmaÅŸÄ±k koordinasyon yapÄ±larÄ±

## Turkish morphology limitation

Mevcut katman TÃ¼rkÃ§e ekleme ve Ã§ekim sistemini tam Ã§Ã¶zmez. Bu yÃ¼zden:

- fiil Ã§ekimleri
- tamlayan/tamlanan iliÅŸkileri
- zaman / kip / kiÅŸi ekleri
- baÄŸlamsal anlam kaymalarÄ±

tam bir dil Ã§Ã¶zÃ¼mleyicisi gibi ele alÄ±nmamalÄ±dÄ±r.

## Compound claim limitation

Ã‡oklu iddialar tek satÄ±rda geldiÄŸinde parser sÄ±nÄ±rÄ± hÄ±zlÄ±ca daralÄ±r. Bu durumda:

- tek paragrafÄ± tek fact sanmamalÄ±
- uzun anlatÄ±mÄ± kÃ¼Ã§Ã¼k kontrollÃ¼ ifadelere bÃ¶lmek tercih edilmelidir
- karmaÅŸÄ±k metinler iÃ§in domain parser dÃ¼ÅŸÃ¼nÃ¼lmelidir

## Optional parser strategy

Gelecekte parser'lar opsiyonel adapter olarak tasarlanmalÄ±dÄ±r:

```txt
Parser Adapter
- parse(input, opts)
- returns claims/subclaims/entities/relations
- must be deterministic or mark nondeterministic mode
- must preserve provenance
- must not auto-admit canonical memory
- must pass through verification/admission gate
```

OlasÄ± adapter tÃ¼rleri:

- controlled-language parser
- domain parser
- legal parser
- aviation parser
- medical parser
- LLM-assisted parser, yalnÄ±zca aday mod olarak

## Recommended public position

AXIOM/Huqan iÃ§in doÄŸru kamu dili ÅŸudur:

- veri ve graph katmanÄ± deterministik
- parser kontrollÃ¼ ifadeler iÃ§in tasarlanmÄ±ÅŸ
- verifier, parser'dan Ã§Ä±kan iddialarÄ± graph/trust katmanÄ±nda deÄŸerlendiriyor
- karmaÅŸÄ±k doÄŸal dil iÅŸleri iÃ§in ayrÄ± parser/adaptor yolu gerekir