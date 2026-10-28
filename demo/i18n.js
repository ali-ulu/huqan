'use strict';

(function () {
  var t = {
    tr: {
      title: 'HUQAN — Güven sınırının içinden',
      description: 'HUQAN: Bir AI ajanının önerisini, hafızaya yazılmadan veya eylem çalışmadan önce kanıt, kapsam, politika ve onay üzerinden inceleyen yerel güven sınırı.',
      stepTitles: [
        'Öneri henüz eylem değildir.',
        'Bağlam, kararın bir parçasıdır.',
        'Politika, yürütmeden önce uygulanır.',
        'Karar, kanıtıyla birlikte kaydedilir.'
      ],
      stepDescriptions: [
        'Ajanın iddiası, araç çağrısı veya değişiklik isteği değerlendirme sınırına alınır. Önce hangi yüzeyin ne yapmak istediği anlaşılır.',
        'Kaynak ve provenance, çalışma alanı, kimlik, araç, risk ve bilinen durum bir araya getirilir. Eksik bağlam güven varsayımına dönüştürülmemelidir.',
        'Politika kararı izin, inceleme, dry-run veya engel olabilir. Review ve block gibi sonuçlarda gerçek executor çağrılmaz; gerekli onay ayrı bir operatör adımıdır.',
        'Trust Receipt, kararın hangi sınırda ve hangi bağlamla alındığını görünür kılar. Bu kayıt evrensel doğruluk iddiası değil, belirli bir kararın kanıtıdır.'
      ],
      stepChips: [
        ['agent', 'action', 'workspace'],
        ['provenance', 'scope', 'risk'],
        ['policy', 'approval', 'executor'],
        ['decision', 'receipt', 'audit']
      ],
      stepFiles: [
        'agent.js · lib/agent-action-firewall',
        'lib/agent-identity-runtime-resolve.js · workspace gates',
        'lib/external-action-guard · approval runtime',
        'lib/receipt/ · SECURITY_INVARIANTS.md'
      ],
      scenarioRisk: { low: 'DÜŞÜK', medium: 'ORTA', high: 'YÜKSEK', critical: 'KRİTİK' },
      decisions: {
        block: { badge: 'BLOCK', title: 'Yürütme engellenir.', body: 'Bu örnekte politika riski kabul etmiyor. Gerçek executor çağrılmamalıdır.', executor: 'NOT CALLED', css: 'decision-block' },
        review: { badge: 'REVIEW', title: 'İnsan incelemesi beklenir.', body: 'İstek beklemede tutulur. Onay alınmadan gerçek executor çalışmamalıdır.', executor: 'PENDING REVIEW', css: 'decision-review' },
        allow: { badge: 'ALLOW', title: 'İstek izinli yoldan geçebilir.', body: 'Örnek politika salt-okuma isteğine izin veriyor. Bu statik demoda gerçek komut çalıştırılmaz.', executor: 'WOULD BE ALLOWED', css: 'decision-allow' },
        approved: { badge: 'ALLOW AFTER REVIEW', title: 'Onaydan sonra izin verilebilir.', body: 'Simüle edilen operatör onayı kayda eklendi. Bu tarayıcıda yine gerçek bir eylem çalıştırılmadı.', executor: 'WOULD BE ALLOWED', css: 'decision-approved' }
      },
      copyOk: 'Kopyalandı',
      copyFail: 'Kopyalanamadı',
      matchCount: function (count, total) { return window.HUQANFormatNumber(count) + ' sonuç / ' + number(total) + ' kayıt'; },
      noMatches: 'Bu filtrelerle eşleşen yol bulunamadı.',
      loading: 'Repo envanteri yükleniyor…',
      loadError: 'Envanter yüklenemedi. Canlı repo ağacını açın.',
      rootLabel: 'Kök',
      folder: 'KLASÖR',
      file: 'DOSYA',
      noSize: 'boyut kaydı yok',
      page: function (current, total) { return current + ' / ' + total + ' sayfa'; },
      approvalRecorded: 'Simülasyon operatörü onayı kaydedildi. Bu bir gerçek onay kaydı değildir.',
      copyReceipt: 'JSON kopyala',
      evaluate: 'İsteği değerlendir'
    },
    en: {
      title: 'HUQAN — Inside the trust boundary',
      description: 'HUQAN: A local trust boundary that evaluates an AI agent proposal against evidence, scope, policy and approval before memory is written or an action executes.',
      stepTitles: [
        'A proposal is not yet an action.',
        'Context is part of the decision.',
        'Policy is applied before execution.',
        'The decision is recorded with its evidence.'
      ],
      stepDescriptions: [
        'An agent claim, tool call or requested change enters an evaluation boundary. First identify which surface is trying to do what.',
        'Provenance, workspace, identity, tool, risk and known state are considered together. Missing context should not silently become trust.',
        'Policy can allow, request review, require dry-run or block. For outcomes such as review and block, the real executor must not run; required approval is a separate operator step.',
        'A Trust Receipt makes the boundary and context behind a decision inspectable. It is evidence of a specific decision, not a claim of universal truth.'
      ],
      stepChips: [
        ['agent', 'action', 'workspace'],
        ['provenance', 'scope', 'risk'],
        ['policy', 'approval', 'executor'],
        ['decision', 'receipt', 'audit']
      ],
      stepFiles: [
        'agent.js · lib/agent-action-firewall',
        'lib/agent-identity-runtime-resolve.js · workspace gates',
        'lib/external-action-guard · approval runtime',
        'lib/receipt/ · SECURITY_INVARIANTS.md'
      ],
      scenarioRisk: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' },
      decisions: {
        block: { badge: 'BLOCK', title: 'Execution is blocked.', body: 'In this example, policy rejects the risk. The real executor must not be called.', executor: 'NOT CALLED', css: 'decision-block' },
        review: { badge: 'REVIEW', title: 'Human review is required.', body: 'The request is held. The real executor must not run until approval is received.', executor: 'PENDING REVIEW', css: 'decision-review' },
        allow: { badge: 'ALLOW', title: 'The request may pass the permitted path.', body: 'The example policy allows a read-only request. This static demo does not run a real command.', executor: 'WOULD BE ALLOWED', css: 'decision-allow' },
        approved: { badge: 'ALLOW AFTER REVIEW', title: 'It may proceed after approval.', body: 'Simulated operator approval has been added to the record. No real action ran in this browser.', executor: 'WOULD BE ALLOWED', css: 'decision-approved' }
      },
      copyOk: 'Copied',
      copyFail: 'Copy failed',
      matchCount: function (count, total) { return window.HUQANFormatNumber(count) + ' matches / ' + number(total) + ' entries'; },
      noMatches: 'No paths match these filters.',
      loading: 'Loading repository inventory…',
      loadError: 'Could not load the inventory. Open the live repository tree.',
      rootLabel: 'Root',
      folder: 'DIR',
      file: 'FILE',
      noSize: 'size not recorded',
      page: function (current, total) { return 'Page ' + current + ' / ' + total; },
      approvalRecorded: 'Simulated operator approval recorded. This is not a real approval record.',
      copyReceipt: 'Copy JSON',
      evaluate: 'Evaluate request'
    }
  };
  var currentLanguage = 'tr';
  t.setLanguage = function (nextLanguage) { currentLanguage = nextLanguage === 'en' ? 'en' : 'tr'; };
  window.HUQANI18N = t;
  window.HUQANFormatNumber = function (value) {
    return new Intl.NumberFormat(currentLanguage === 'tr' ? 'tr-TR' : 'en-US').format(value);
  };
})();
