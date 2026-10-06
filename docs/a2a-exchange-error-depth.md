# A2A tipli hata kaydı + delegasyon derinlik sınırı — R25

`require('huqan').buildExchangeErrorRecord({ errorType, errorMessage,
traceback })` exchange sonucuna tipli hata kaydı yapar:
`{error_type, error_message, traceback_hash}`. Ham trace asla saklanmaz;
verilen traceback yalnızca sha256 hash'iyle kayda girer, yoksa hash `null`
olur. Mesaj 1024 baytla, traceback 8192 baytla sınırlıdır.

Tip kelime dağarcığı uydurulmaz: evaluator neden kümesi
(`RETRYABLE_EVALUATOR_REASONS`) artı exchange'in ürettiği üç terminal kod
(`replay_detected`, `verification_failed`, `admission_invalid`). Bilinmeyen
tip kaydı reddedilir; `classifyExchangeErrorType` mevcut retry allowlist'ini
yeniden kullanır, bu yüzden bilinmeyen `error_type` asla retryable olmaz.
`isRetryableErrorRecord` dövme kayıtlara karşı şekil + sürüm + tip doğrular.

`require('huqan').evaluateDelegationDepth(delegation)` zincirdeki ajan
sayısını (`depth`) ve sıralı ziyaret kümesini (`visitedAgentIds`) döndürür;
`withinBounds` 1..16 aralığı ve tekrarsızlığı ister. Sınır
`MAX_DELEGATION_DEPTH = 16`, doğrulayıcının zaten uyguladığı değerin adıdır;
`validateDelegation` içindeki sihirli sayının yerini alır. Aşım yine mevcut
`delegation_chain_invalid` ile kapanır — yeni neden dizesi, allowlist
değişikliği ve tel değişikliği yoktur. Derinlik kanıtı kayıtta/hostta yaşar,
blok kararı eskisi gibi tek nedende kalır.

Doğrulama: `test/a2a-exchange-error-depth.test.js` kayıt şekli, hash
doğruluğu, ham-trace yokluğu, allowlist kabulü (bilinmeyenin girememesi
dahil), 16/17 sınırı, tekrarlı/boş zincir ve geçerli fixture'ın hâlâ `allow`
dönmesini kapsar. `node scripts/a2a-error-depth-mutation.js` iki dar mutantı
öldürür (sınıflandırıcıyı hep-true'ya çevirme; sınırı büyütme); kaynak
dosyasını değiştirmez.
