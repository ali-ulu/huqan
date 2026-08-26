# Observability Dashboard Accessibility and Responsive Audit

Bu dilim, static Observability dashboard’ının klavye, ekran okuyucu ve dar ekran davranışını ölçülebilir bir contract yüzeyi olarak sabitler. Amaç WCAG uyumluluğu veya tüm cihazlarda görsel kusursuzluk iddiası değil; canlı source üzerinde doğrulanabilir temel kullanılabilirlik sınırlarını korumaktır.

## Doğrulanan davranışlar

| Alan | Kabul edilen davranış |
| --- | --- |
| Navigation | Sidebar navigation bir `Primary navigation` landmark’ıdır; collapsed görünümde her view button’ı anlamlı `aria-label` taşır. |
| Search | Üst arama alanı placeholder’a bağımlı kalmadan erişilebilir bir label taşır. |
| Keyboard focus | Button, input, select ve textarea için görünür `:focus-visible` outline; list/detail etkileşimli satırlarında da görünür focus vardır. |
| Disabled state | Disabled pagination/action button’ları düşük opacity ve `not-allowed` cursor ile etkileşimsiz durumunu açıkça gösterir. |
| Dynamic status | Mevcut loading/error/status surface’leri `role="status"` ve/veya `aria-live="polite"` ile güncellemeleri duyurur. |
| Reduced motion | `prefers-reduced-motion: reduce` altında dashboard animasyon ve transition’ları kapatır. |
| Narrow screens | 600px altında header, head/actions, metrics, iki kolonlu paneller, filter controls, tool legend ve footer tek kolon veya yatay scroll ile kullanılabilir kalır. |
| Content overflow | Main view’lar dikey scroll edilebilir; tool legend ve footer metadata dar ekranda clipping yerine bounded scroll kullanır. |
| Touch target | Mobile navigation button’ları en az 52px, genel action button’ları en az 40px minimum yüksekliğe sahiptir. |

## Kapsam sınırları

Bu audit static contract ve source-level responsive kurallarını kapsar. Gerçek cihaz/browser matrisi, otomatik renk-kontrast laboratuvar ölçümü, screen-reader vendor doğrulaması, hosted deployment davranışı, üçüncü taraf kullanıcı testi veya evrensel WCAG conformance kanıtı değildir. Dashboard’ın görsel data viz yüzeyleri ve canvas/SVG içeriği ayrıca ürün tasarım incelemesi gerektirebilir.
