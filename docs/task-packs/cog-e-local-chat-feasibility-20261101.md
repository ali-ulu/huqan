# COG-E — Kendi ağırlıklarıyla yerel sohbet fizibilite kaydı

İlgili iş: [#4395](https://github.com/ali-ulu/huqan/issues/4395) (COG-E), üst plan
[#4390](https://github.com/ali-ulu/huqan/issues/4390), ana program [#4060](https://github.com/ali-ulu/huqan/issues/4060).
Önkoşul kayıtlar: `docs/audits/laya-closure-audit-20261101.md` (karar **STAY_SHADOW**),
`docs/task-packs/cog-d-interpreter-preregistration-20261101.md` (D ön-kaydı).

Kapsam: E'nin **fizibilite kapısı** için kayıt. Plan E: *"Saf JS/kendi ağırlıkları şartıyla
çalışabilirlik gerçek makinede ölçülür; ONNX export tek başına kabul edilmez. Uygulanamazsa
FEASIBILITY_BLOCKED raporu verilir, runtime yasağı sessizce değiştirilmez."*

Bu belge **ölçüm değil**, kanıt taramasıdır: eğitim yüzeyinin (huqan-decision-engine) şeklini
kaydeder ve fizibilite kapısının bu ortamdan koşulamadığını açık yazar. Kod, model indirme,
eğitim ve runtime değişikliği yoktur.

## 1. Eğitim yüzeyi: `ali-ulu/huqan-decision-engine`

| Öğe | Değer |
| --- | --- |
| Son commit | `af8b953c` (2026-10-24, "docs: laya-v1 results and gate verdict") |
| Branch / PR / tag / release | yalnız `main`; PR yok, tag yok, release yok |
| CI | yok |
| Depo boyutu | 6.0 MB (ağırlıklar git'te değil) |
| Checkpoint | `huqanulu/laya-v1-ckpt` özel Kaggle dataset'i (644 MB, `model.safetensors`) |
| Lisans | depo lisansı belirtilmemiş; base `convaiinnovations/laya-multilingual` Apache-2.0 (base model MIT) |

Depo bir **artifact deposudur**: kod (`audit/`, `eval/`, `bench/`, `train/`), sonuç JSON'ları ve
metadata. Eğitim Kaggle/Colab tarafında sürer; depo yalnız çıktıyı kaydeder. Bu yüzden "git'te
yeni commit yok" eğitimin durduğu anlamına gelmez — aşağıdaki §4 bu ayrımı korur.

**Bulgu (depo dokümanı gecikmiş):** `README.md` durum tablosu (2026-10-21) hâlâ *"Fine-tune
laya-multilingual … not started"* ve *"ONNX export + run inside HUQAN … not started"* yazar;
oysa depo 2026-10-24'te `train/laya-v1/` fine-tune sonuçlarını (`af8b953c`) zaten içerir. Tablo
güncellenmemiştir; depo durumu için tek otorite commit'ler ve `train/laya-v1/results/` içeriğidir.

## 2. Bulgu: eğitim yüzeyinde üretken hat yok

Depodaki her model **karar/sınıflandırıcı** biçimindedir; üretken (decoder-only, otoregresif)
hiçbir bileşen yoktur.

| Bileşen | Tür | Üretken mi? |
| --- | --- | --- |
| `train/laya-v1` | mmBERT-base + typed head (choice/noul/score) | **Hayır** — encoder + sınıflandırma başlığı |
| `eval/kev-mem` | Qwen3.5-0.8B-Base + LoRA + decision head | **Hayır** — karar başlığı; token üretmez |
| `eval/r50` | Laya checkpoint'i R50 çiftlerinde skorlar | **Hayır** — `noul` olasılığı döndürür |

Depo README'si bunu açıkça yazar: *"A decision model does not generate text. It reads a state
(a memory, a ticket, an agent output) plus typed questions and returns a probability for every
option."* Tokenizer, sampler, KV cache veya otoregresif döngü içeren hiçbir kod yoktur
(`grep -riE "generate|chat|autoregress"` yalnız README'deki bu olumsuz cümleyi bulur).

**Sonuç:** E'nin istediği "kendi ağırlıklarıyla doğal yanıt üretimi" için depoda **hiçbir
artifact yoktur**. Mevcut tek model ailesi (laya/kev-mem) sınıflandırıcıdır; üretken sohbet
yapamaz.

## 3. Bulgu: Node/JS çalıştırma yolu yalnız encoder + head

Plan E "saf JS/kendi ağırlıkları" ister. Deponun kaydettiği tek Node yolu:

- `@receptron/laya` (ONNX Runtime, ~2 GB RAM, CPU'da ~140 ms / 3 soru) — **encoder + typed head**
  çalıştırır; bir karar döndürür.
- mmBERT tokenizer'ında `[CLS]/[SEP]/[MASK]/[PAD]` sabit kodlu olduğundan multilingual yol
  `laya-ts` export'u (`encoder.onnx` + `head.onnx`) gerektirir (denetim §6, FEASIBILITY_BLOCKED).

Bu yol bir **sınıflandırıcıyı** çalıştırır. Üretken sohbet için decoder-only model, tokenizer,
otoregresif örnekleyici ve KV cache gerekir; `@receptron/laya` bunların hiçbirini sağlamaz.
Yani mevcut Node yolu E'ye genellenemez.

## 4. Bulgu: bu ortamda fizibilite kapısı koşulamaz

Fizibilite kapısı "gerçek makinede ölçülür" der. Bu ortamda:

| Gereksinim | Durum |
| --- | --- |
| Üretken model ağırlığı | yok (depoda yok; checkpoint özel Kaggle dataset'inde) |
| Kaggle erişimi | yok (kimlik bilgisi/kurulum yok) |
| GPU | yok (4 çekirdek, 15 GB RAM, Node 24) |
| Üretken tokenizer / sampler | depoda yok |

Bu koşullarda ölçüm üretilemez. Ayrıca **eğitim Kaggle/Colab tarafında sürdüğü için**, depodaki
statik görünüm kapıyı kapatmaz: kapı **canlı checkpoint** çıktısına karşı yeniden koşulmalıdır.

## 5. Karar

| Kapı | Durum |
| --- | --- |
| Depoda üretken artifact var mı | **hayır** |
| Node/JS üretken inference yolu var mı | **hayır** (yalnız encoder+head) |
| Bu ortamda ölçüm yapılabildi mi | **hayır** |
| **Verdict** | **`FEASIBILITY_BLOCKED` (NOT_MEASURED)** |

`FEASIBILITY_BLOCKED`, "sonsuza dek imkânsız" değildir: **mevcut kanıtla üretken hat yok**
demektir. Eğitim sürdüğü için bu kayıt canlı çıktıya karşı yeniden değerlendirilmelidir. Runtime
yasağı (dış modele ağ çağrısı yok; `/v1/chat/completions` dış modele aktarıcıdır) **sessizce
değiştirilmedi**; kontrollü şablon veya proxy "tam yerel sohbet" diye sunulmaz.

## 6. E'nin kalanı için önkoşullar

1. **Üretken model kararı:** ayrı bir üretken (decoder-only) model hattı mı, yoksa E'nin
   `FEASIBILITY_BLOCKED` olarak kapanması mı — ayrı bir mimari kararı olarak kaydedilmeli.
   Mevcut sınıflandırıcı hattı bu kararı üretmez.
2. **Lisans kapısı:** depo lisansı ve üretken model adayının lisansı allowlist'e girmeli
   (D ön-kaydı §2 kapı kuralı). Bev-decision lisansı bilinmiyor (denetim §5).
3. **Gerçek makinede ölçüm:** saf JS/kendi ağırlıkları ile CPU/RAM/gecikme/token bütçesi;
   ONNX export tek başına kabul değil.
4. **Kabul senaryoları:** gerçek conversation dispatcher; model yükleme/yanıt/iptal/timeout/OOM/
   restart; state-response uyumu; duygu uydurmama; prompt injection/tenant izolasyonu.

Bu adımlar E'nin kalan işidir; bu kayıt onları başlatmaz.

## 7. Sınırlar (bu kaydın iddia etmedikleri)

- Üretken sohbetin **imkânsız** olduğunu iddia etmez; yalnız depoda artifact olmadığını gösterir.
- Eğitimin durduğunu iddia etmez; depo commit tarihi eğitim durumunun kanıtı değildir.
- Ölçülmüş CPU/RAM/gecikme sayısı içermez (`NOT_MEASURED`).
- Laya'yı terfi ettirmez (`STAY_SHADOW` korunur); D ön-kaydını değiştirmez.
