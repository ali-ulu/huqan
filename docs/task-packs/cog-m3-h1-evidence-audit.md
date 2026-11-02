# COG-M3 H1 — kanıt kapsamı denetimi

Bu kayıt, gerçek ve bağımsız görev corpus'u hedefi açısından mevcut H1
uygulamasının salt okunur kaynak denetimidir. İncelenen main:
`466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf`; H1 uygulaması `203fe50c`,
sonuç kaydı `7fc75087` ile eklenmiştir. #4465 kapalıdır; kapanış kendi başına
bu denetimdeki eksik kanıtları karşılamaz.

## Sonuç

Mevcut `MEASURED_NO_GAIN` kaydı, oluşturulmuş fixture üzerindeki tanısal sonuç
olarak korunur. Kodda gerçek mühürlü Coder koşumları bulunması, görevlerin
gerçek dış kaynaklardan geldiğini veya ailelerin anlamsal olarak bağımsız
olduğunu kanıtlamaz. Gerçek bağımsız corpus hedefi tamamlanmış değildir.
Bu denetimde test veya runtime çalıştırılmadı: `NOT_RUN`.

## Kaynak ve görev ayrımı

[Üretici](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/test/helpers/cog-m3-h1-corpus.js#L64-L109)
her indeks için `value-<i>.js`, `alpha<i>` ve `beta<i>` oluşturur; pozitif ve
negatif kaynak dosyalarını ve qualification girdilerini aynı fabrikada kurar.
Burada gerçek dış issue veya görev kökeni gösterilmez. Kaynak koşumlarının
mühürlenmesi, çalışma kaydının bütünlüğü hakkında kanıttır; görev kökeni veya
anlamsal bağımsızlık hakkında ayrı bir kanıt değildir.

[Aynı üretici](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/test/helpers/cog-m3-h1-corpus.js#L193-L201)
oracle beklenen hash'lerini de `family.replace` değerinden türetir. Ayrı oracle
dosyası ve farklı digest'ler, bağımsız hazırlanmış bir oracle kanıtlamaz.
[Sonuç kaydı](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/docs/task-packs/cog-m3-h1-result-20261101.md#L129-L134)
aile etiketlerinin çağıran beyanı ve değerlendirme görevlerinin fixture olduğunu
belirtir. Hash veya etiket farklılığı tek başına soy ve bağımsızlık ispatı değildir.

## Aileler ve transfer

[Oluşturma döngüsü](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/test/helpers/cog-m3-h1-corpus.js#L179-L201)
24 aile oluşturur; ilk sekize `T` etiketli transfer görevi ekler ve aynı
`familyId` kullanır. Bu nedenle 24 ailenin anlamsal bağımsızlığı kanıtlanmış
değildir; ayrıca sekiz bağımsız transfer ailesi de gösterilmemiştir. Bu tespit,
sekiz transfer görev kaydının varlığını inkâr etmez.

## Yetki ve yürütme sınırı

[Native kol](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/test/helpers/cog-m3-h1-corpus.js#L140-L157)
`runFixLoop` çağrısına `authorized: true` verir ve mühürlü koşumu okur.
[Sonuç belgesi](https://github.com/ali-ulu/huqan/blob/466abb3cbaadf8fbeed1ce87d68f3ce84b3d54bf/docs/task-packs/cog-m3-h1-result-20261101.md#L118-L125)
canlı promotion, canary ve admission yolunun çalıştırılmadığını bildirir.
Dolayısıyla bu kayıt tam gerçek approval/promotion/admission zincirinin kanıtı
değildir; maliyet de `NOT_MEASURED` olarak raporlanmıştır.

## Korunan sözleşme

[Corpus planındaki](cog-m3-corpus-plan.md) 24 bağımsız holdout ve ayrıca 8
bağımsız transfer ailesi, `K=32`, ayrı oracle ve gerçek yürütme yolu sınırları
bu denetimle değişmez. Bu belge yeni bir deney sonucu, kazanç veya genel yetenek
iddiası üretmez; issue durumunu değiştirmez.
