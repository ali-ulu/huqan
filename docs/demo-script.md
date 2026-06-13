# Demo Script

## 60-second explanation

AXIOM / HUQAN, deterministic verification ve memory tabanlÄ± bir gÃ¼ven katmanÄ± sunar. AmaÃ§, modeli â€œdaha Ã§ok konuÅŸanâ€ hale getirmek deÄŸil; iddialarÄ± daha kontrollÃ¼ ve denetlenebilir hale getirmektir.

## What HUQAN is

- deterministik
- local-first
- claim verification odaklÄ±
- provenance ve audit Ã¼reten
- insan incelemesi iÃ§in izlenebilir

## What HUQAN is not

- tam bir NLP motoru
- her doÄŸal dili sÄ±nÄ±rsÄ±z anlayan bir sistem
- â€œtruth guaranteesâ€ veren bir araÃ§
- production-scale graph iddiasÄ± kanÄ±tlanmÄ±ÅŸ bir platform
- otomatik olarak kendi kendini onaylayan bir ajan

## Demo flow

### 1. Teach / learn a fact

```bash
node cli.js
```

Ã–rnek:

```txt
learn: cats are animals
```

Beklenen:

- yeni bilgi kabul edilir
- provenance ve audit mantÄ±ÄŸÄ± bozulmaz

### 2. Verify a supported claim

Ã–rnek:

```txt
verify: kedi bitkidir
```

Beklenen:

- desteklenen veya Ã§eliÅŸen durum net gÃ¶rÃ¼nÃ¼r
- sonuÃ§ deterministik gÃ¶rÃ¼nÃ¼r

### 3. Verify an unsupported claim

Ã–rnek:

```txt
verify: mars'ta ÅŸu an ÅŸirket kuruldu
```

Beklenen:

- yeterli kanÄ±t yoksa bilinen biÃ§imde reddedilir veya bilinmiyor dÃ¶ner
- sistem uydurma cevap Ã¼retmez

### 4. Verify a contradiction

Ã–rnek:

```txt
verify: kedi hayvandÄ±r
verify: kedi bitkidir
```

Beklenen:

- Ã§eliÅŸki sinyali veya doÄŸrulanmÄ±ÅŸ / doÄŸrulanmamÄ±ÅŸ ayrÄ±mÄ± gÃ¶sterilir
- kullanÄ±cÄ± graph etkisini gÃ¶rebilir

### 5. Show reasoning / receipt if available

Beklenen:

- doÄŸrulama izi gÃ¶rÃ¼nÃ¼r
- gerekirse audit / receipt mantÄ±ÄŸÄ± anlatÄ±lÄ±r

## Safe wording

ÅunlarÄ± sÃ¶yle:

- deterministic verification
- human-reviewed outputs
- scoped PRs and release gates
- local-first knowledge graph

ÅunlarÄ± sÃ¶yleme:

- guarantees truth
- eliminates hallucinations
- production-scale graph
- full NLP engine

## Closing pitch

**Models generate. Agents act. Memory stores. HUQAN judges.**