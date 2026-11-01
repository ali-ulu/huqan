# M3/B4 — Gerçek görev kaynağı uygunluk envanteri

İş: [#4465](https://github.com/ali-ulu/huqan/issues/4465). Program: [#4060](https://github.com/ali-ulu/huqan/issues/4060).
Durum: `NOT_READY`; H1 deneyi `NOT_RUN`; `assertsGain:false`.
Bu teslim yalnız gözlenen açık issue havuzunda kaynak uygunluğunu tarar.
Corpus tamamlanmış, oracle hazırlanmış veya bağımsız denetçi atanmış değildir.

## Gözlenen havuz ve sınır

`ali-ulu/huqan` public deposunda `gh issue list --state open --limit 100`
çalıştırıldığında, JSON'da kaydedilen 2026-11-01 18:53:13.098 UTC gözleminde altı açık issue
gözlendi: #4470, #4465, #4396, #4395, #4394 ve #4060. #4465 bu işin
koordinasyon/öz değerlendirme kaydı olduğundan aday havuzundan ayrı tutuldu.
Diğer beş issue'nun gövdeleri incelendi: bu havuzda uygun bounded Coder
görevi yok; sonuç **0 kabul / 5 ret**. Bu bulgu yalnız bu havuza ilişkindir,
tüm public depolar veya diğer kaynak havuzları hakkında hüküm değildir.

Her gövdenin gözlenen sürümü, gövde SHA-256'sı ve ret gerekçesi
[eşlik eden JSON envanterindedir](cog-m3-corpus-intake.json). JSON bu belgeyle
birlikte kaynak kaydıdır; runtime manifest, ön-kayıt veya deney kilidi değildir.

| Issue | Gövdeye dayalı ret gerekçesi | Görev öncesi SHA | Aile bağımsızlığı | Split |
| --- | --- | --- | --- | --- |
| [#4470 — G3 closure-gate ölçümleri](https://github.com/ali-ulu/huqan/issues/4470) | Ölçüm/closure boyutlarını tarif ediyor; sınırlı Coder yolunda çözülebilecek özgün açık hata/bakım girdisi veya orijinal görev örneği sunmuyor. | Bilinmiyor | Bilinmiyor | Yok |
| [#4396 — Duygu-sohbet-eylem döngüsü](https://github.com/ali-ulu/huqan/issues/4396) | Bağımsız G1/G2/G3 deney planı; bounded Coder hata görevi ve orijinal açık görev örneği yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4395 — Doğal sohbet fizibilitesi](https://github.com/ali-ulu/huqan/issues/4395) | Model, inference ve gerçek conversation yolu fizibilitesi; M3'ün sınırlı Coder görev girdisi yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4394 — Laya denetimi ve distillation](https://github.com/ali-ulu/huqan/issues/4394) | Öğretmen/veri/eğitim ve model değerlendirmesi; bounded Coder hata görevi örneği yok. | Bilinmiyor | Bilinmiyor | Yok |
| [#4060 — COG program epic](https://github.com/ali-ulu/huqan/issues/4060) | Program kabul kapıları ve koordinasyon; özgün, tekil Coder bakım/hata görevi değil. | Bilinmiyor | Bilinmiyor | Yok |

`sourceCommit` değeri `34824d75a50114e6580d6d58878b708e90af76a6`, tarama
anındaki HUQAN kod tabanıdır; issue öncesi kod veya görev öncesi artefakt SHA
değildir. Gövdelerden görev öncesi SHA, ortak ancestor ve aile bağımsızlığı
kanıtı çıkmadı. #4465'in kendisi aday değerlendirmesi değildir; JSON'da ayrı
`excluded` kaydı olarak tutulur. `reviewed`/incelenmiş olma kaydı, bağımsız
harici denetçinin var olduğu iddiası taşımaz.

## Sonraki adım ve sabit sınırlar

Bir sonraki somut kaynak çalışması, ayrı ve dondurulmuş gerçek operatör görevi
veya bağımsız depo aday havuzudur. İlk uygun gerçek görev qualification ve
oracle ayrımı için incelenebilir; 24 holdout ile 8 transfer ailesi ayrıca
köken denetimi ve sonuç öncesi kilit ister. Bu issue taramasındaki görevleri
sentetik Coder görevlerine dönüştürmek veya uygun örnek gibi etiketlemek yoktur.

M3 ön-kaydı ([bağlantı](cog-m3-replay-preregistration-20261027.md)) ve aile
değerlendirme sözleşmesi ([bağlantı](cog-m3-family-evaluation-contract.md))
korunur: 24 bağımsız holdout + ayrıca 8 bağımsız transfer ailesi, `K=32`,
ayrı oracle, source/qualification/evaluation ayrımı, ön kilit ve aynı gerçek
approval/promotion/admission/native Coder kabul-rollback yolu. H1 `NOT_RUN`,
corpus `NOT_READY`, `assertsGain:false`; bu envanter bunları değiştirmez.
G3 closure-gate issue #4470 ayrı ve bu teslimle kapanmaz.
