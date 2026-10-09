# R55 PR3: veri kuralı ve ön-kayıt eki

**Base:** issue [#3717](https://github.com/ali-ulu/huqan/issues/3717) (R55). R51 ön-kaydı
(`docs/task-packs/semantic-model-preregistration-r51.md`) **değiştirilmedi**; bu dosya ona
yazılı bir **ek**tir ve yalnız aşağıda adı geçen kuralı genişletir.

## Sahibin kararı (2026-10-09)

R51 ön-kaydı her eğitim çifti için en az iki farklı öğretmen kimliği ister. İnsan etiketli
NLI corpus'larında (SNLI 1.0, SNLI-TR 1.1) bağımsız ikinci bir öğretmen yoktur: etiketler aynı
kaynaktaki insan anotatörlerden gelir. HUQAN sahibi şu istisnayı onayladı:

> Bir satırdaki insan anotatör etiketlerinin dağılımı, o çift için **tek bir altın öğretmen**
> sayılır: `teacherId: human-annotators`.

Bu, R51 PR4b'de inceleme kararları için kurulan `human-review` kuralının aynısıdır.
Uygulama: `scripts/semantic-teacher-contract.js` `HUMAN_GOLD_TEACHER_IDS`
(`human-review`, `human-annotators`); başka hiçbir tek-öğretmen kaydı kabul edilmez.

## Sınırlar

- Etiket, satırın `annotator_labels` dağılımıdır (yumuşak etiket). SNLI eğitim satırlarında
  çoğunlukla yalnız cümleyi yazan kişinin etiketi vardır; dev satırlarında beş doğrulayıcı.
  Bu fark gizlenmez: dağılım olduğu gibi kullanılır.
- `gold_label` `-` olan (uzlaşma olmayan) ya da kullanılabilir anotatör etiketi taşımayan
  satırlar düşürülür ve sayılır; tekrar eden metin çiftlerinde ilk kayıt tutulur.
- Split corpus'unkidir: SNLI `train` → `train`, SNLI `dev` → `calibration`.
  **SNLI `test` hiç okunmaz**; kapasite ölçümü için temiz kalır.
- R50 holdout sızıntı kontrolü ve açık lisans kontrolü veri seti kurucusunundur;
  her iki corpus da CC-BY-SA-4.0'dır (SNLI-TR README'si: "licensed under the same terms as
  SNLI which is Creative Commons Attribution-ShareAlike 4.0").
- Model öğretmenleri bu çiftlerde ortalamaya girmez; insan etiketi tektir.

## Kapsam dışı

Bu ek kalite iddiası değildir. Paketlenecek artifact'ın kabulü R51'in donmuş eşikleriyle,
R50 holdout'unda ölçülür (R55 PR4). Yalnız-hipotez tabanı her raporda yan sütundur.

## Komutlar

```sh
node scripts/build-semantic-snli-dataset.js <dir> <en|tr> <trainLimit> <calibrationLimit> <sourceCommit> dataset.json
node scripts/train-semantic-model-v2.js dataset.json <en|tr> <sourceCommit> model.json
node scripts/calibrate-semantic-model.js dataset.json model.json calibration.json
```
