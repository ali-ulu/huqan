# LESSONS

## KALICI KURALLAR

- Kullanıcının sorusunu yeniden etiketleme. Verdict/başlık/özet cümlelerinde
  kullanıcının kendi terimini birebir kullan; repo dokümanlarından okunan
  benzer ama daha dar/geniş etiketi onun yerine geçirme. Terim farkı kapsam
  farkı demektir; kapsam belirsizse varsayma, sor.

## 2026-08-18 — HUQAN / agent action firewall hazırlık değerlendirmesi

- HATA: Kullanıcının "agent action firewall" sorusu, cevabın verdict bölümünde
  "coding agent action firewall" olarak yeniden etiketlendi.
- KÖK NEDEN: `docs/v4/v4-pr-plan.md:146` içindeki "Coding Agent Action Firewall"
  demo adı, kullanıcının sorusunun etiketi sanılıp verdict başlığına taşındı.
- KURAL: Değerlendirme/rapor çıktısında kapsam etiketini kullanıcının cümlesinden
  al; repo dokümanından gelen etiketi kullanacaksan kaynağını açıkça yaz ve
  kullanıcının terimiyle karıştırma.
- KAPSAM: Tüm repo; özellikle hazırlık/readiness, audit ve değerlendirme raporları.
