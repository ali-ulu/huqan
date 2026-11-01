# M3/B4 aile değerlendirme bağlantısı

İş: #4069. Durum: hazırlık; bağımsız H1 deneyi `NOT_RUN`.
Bu sözleşme eski ön-kayıt ve karakterizasyon sonuçlarını değiştirmez.

A1 recent-K, A2 priority seçimidir. K=32; iki kol aynı journal/prediction
görüntüsünü, karar öncesi cutoff'u ve tam bağımlılık evrenini kullanır.
Mevcut B4 seed=3310, resamples=2000, confidence=0.95, meaningfulEffect=0,
minimumSamples=24, minimumTransfer=8 ve wrongWriteTolerance=0 korunur.

Birincil örnekleme birimi bağımsız ailedir: önce aile içi görev farklarının
ortalaması alınır, sonra aile ortalamaları eşit ağırlıkla bootstrap edilir.
Tek ailenin tekrarları 24 aile şartını doldurmaz. Aynı seçilmiş ID kümeleri
`INSUFFICIENT`; farklı seçimlerle eşit doğruluk geçerli sıfır-etki tanısıdır.
Herhangi kolda yanlış yazma veya güven ihlali küçük örneklemden önce `REJECT` verir.

Lab girişi açık `m3 --m3-records FILE` komutudur. İstek contract, workspaceId,
asOf, splits, families, tasks, records, oracleFile/oracleHash, protocolHash ve
lockHash içerir. lockHash, kendisi dışındaki tüm isteğin canonical SHA256'ıdır.
protocolHash bu belgenin bayt hash'i; oracleHash ayrı oracle dosyasının hash'idir.
Ailelerin journal/prediction/request hash'leri kilitlenir. Kaynaklar salt okunur
açılır, yeni Graph/depo oluşturulmaz; otomatik onay veya yürütme yapılmaz.

Her aile ortak replay çağrısından elde edilen iki seçimi taşır. Native sonuç
kaydı varsa tam aday/rollback zinciri, workspace, kaynak hash'i ve kullanılan
prosedür hash'i yeniden doğrulanır; `correct` veya `ok` beyanı kabul edilmez.
Oracle beklenen dosya hash'lerini içerir; kaynak/qualification/evaluation
aile etiketleri kesişemez. Eksik native kanıt örneklemden gizlice çıkarılmaz:
bütün rapor `INSUFFICIENT` kalır. Kaynak değişikliği `REJECT` nedenidir.

Dosya hash'leri içerik bağlar, bağımsız imzalı zaman otoritesi değildir.
Ailelerin anlamsal bağımsızlığı, görevin oracle cevabını sızdırmadığı ve
ön-kaydın sonuçtan önce yapıldığı yalnız hash ile kanıtlanamaz. Bu hazırlık
yolunda `assertsGain:false`, `registered:false`, `CANDIDATE_ONLY` korunur;
istatistiksel `clearsEffect` yalnız tanıdır. Gerçek corpus/split/oracle kilidi
ve bağımsız denetim olmadan H1 veya genel öğrenme kazanımı raporlanmaz.

Maliyet sayaçları bu girişte ölçülmez: `NOT_MEASURED`. Kaynak ve kabul kaydı
yeniden okuması, gerçek yeni süreç testleriyle sınanır; sentetik test aileleri
bağımsız gerçek görev örneklemi sayılmaz. G3 kapanışı bu teslimin dışında kalır.
