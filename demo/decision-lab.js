'use strict';

(function () {
  var lang = 'tr';
  var t = window.HUQANI18N;
  var selectedScenario = 'force-push';
  var approvedInSimulation = false;

  var scenarioData = {
    'git-status': {
      title: { tr: 'Salt okunur durum sorgusu', en: 'Read-only status query' },
      action: 'git status',
      policy: 'read-only-commands',
      decision: 'allow',
      risk: 'low',
      riskName: { tr: 'Salt okunur', en: 'Read-only' },
      reason: { tr: 'Örnek profil, çalışma ağacını okuyan komutu izinli salt-okuma yolunda değerlendiriyor.', en: 'The example profile treats a working-tree inspection as a permitted read-only path.' },
      evidence: { tr: ['Read-only sınıfı', 'Workspace kapsamı', 'İzinli politika'], en: ['Read-only class', 'Workspace scope', 'Permitted policy'] },
      receiptId: 'DEMO-ALLOW-001',
      surface: 'external-action-guard'
    },
    'npm-test': {
      title: { tr: 'Politikada ayrıca izinlenmemiş komut', en: 'Command not explicitly allowed by policy' },
      action: 'npm test',
      policy: 'unknown-command-review',
      decision: 'review',
      risk: 'medium',
      riskName: { tr: 'Komut politikası', en: 'Command policy' },
      reason: { tr: 'Varsayılan örnekte bu komut izin listesinde değil. Gürültüyü azaltmak için açıkça izinlenebilir, ancak sessizce çalıştırılmamalıdır.', en: 'In this example, the command is not on the allowlist. It may be explicitly allowed to reduce review noise, but should not silently execute.' },
      evidence: { tr: ['Allowlist eşleşmedi', 'İnceleme gerekli', 'Executor beklemede'], en: ['No allowlist match', 'Review required', 'Executor held'] },
      receiptId: 'DEMO-REVIEW-002',
      surface: 'huqan-gate'
    },
    'learn-fact': {
      title: { tr: 'Kalıcı hafızaya yazma isteği', en: 'Persistent memory write request' },
      action: 'huqan.learn: "cats are plants"',
      policy: 'mutating-requires-review',
      decision: 'review',
      risk: 'high',
      riskName: { tr: 'Kalıcı mutasyon', en: 'Persistent mutation' },
      reason: { tr: 'Hafızaya yeni bir iddia yazmak durum değiştirir. Örnek akış, kanonik yazımdan önce insan incelemesini bekletir.', en: 'Writing a claim to memory changes state. The example flow holds for human review before canonical write.' },
      evidence: { tr: ['Hafıza mutasyonu', 'Admission politikası', 'Onay bekleniyor'], en: ['Memory mutation', 'Admission policy', 'Approval pending'] },
      receiptId: 'DEMO-REVIEW-003',
      surface: 'mcpServer / memory-admission'
    },
    'force-push': {
      title: { tr: 'Yıkıcı Git işlemi', en: 'Destructive Git operation' },
      action: 'git push --force',
      policy: 'destructive-command',
      decision: 'block',
      risk: 'critical',
      riskName: { tr: 'Yüksek etki', en: 'High impact' },
      reason: { tr: 'Force-push, paylaşılan repo durumunu geri döndürülmesi zor biçimde değiştirebilir. Bu örnek politika eylemi başlamadan engeller.', en: 'A force-push can rewrite shared repository state. The example policy blocks the action before it starts.' },
      evidence: { tr: ['Yıkıcı işlem sınıfı', 'Pre-execution gate', 'Fail-closed karar'], en: ['Destructive operation class', 'Pre-execution gate', 'Fail-closed decision'] },
      receiptId: 'DEMO-BLOCK-004',
      surface: 'huqan-gate'
    },
    'unknown-tool': {
      title: { tr: 'Kayıtlı olmayan araç', en: 'Unregistered tool' },
      action: 'unregistered.delete_database()',
      policy: 'unknown-tool-deny',
      decision: 'block',
      risk: 'critical',
      riskName: { tr: 'Bilinmeyen araç', en: 'Unknown tool' },
      reason: { tr: 'Bilinmeyen araç çağrısı varsayılan olarak kabul edilmez. Bağlı yürütme sınırı çağrıyı reddetmelidir.', en: 'An unknown tool call is not trusted by default. The connected execution boundary should reject it.' },
      evidence: { tr: ['Araç kayıtlı değil', 'Açık yetki yok', 'Fail-closed karar'], en: ['Tool not registered', 'No explicit authority', 'Fail-closed decision'] },
      receiptId: 'DEMO-BLOCK-005',
      surface: 'mcp-tool-policy'
    }
  };

  var decisionBadge = document.getElementById('decision-badge');
  var decisionTitle = document.getElementById('decision-title');
  var decisionReason = document.getElementById('decision-reason');
  var riskLabel = document.getElementById('risk-label');
  var factAction = document.getElementById('fact-action');
  var factPolicy = document.getElementById('fact-policy');
  var factExecutor = document.getElementById('fact-executor');
  var decisionEvidence = document.getElementById('decision-evidence');
  var approveButton = document.getElementById('approve-button');
  var approvalNote = document.getElementById('approval-note');
  var receiptJson = document.getElementById('receipt-json');

  function renderScenario() {
    var scenario = scenarioData[selectedScenario] || scenarioData['force-push'];
    var decisionKey = approvedInSimulation && scenario.decision === 'review' ? 'approved' : scenario.decision;
    var decision = t[lang].decisions[decisionKey];
    decisionBadge.textContent = decision.badge;
    decisionBadge.className = 'decision-badge ' + decision.css;
    decisionTitle.textContent = decision.title;
    decisionReason.textContent = decision.body + ' ' + scenario.reason[lang];
    riskLabel.className = 'risk-label risk-' + scenario.risk;
    riskLabel.replaceChildren();
    var riskDot = document.createElement('span');
    riskDot.className = 'risk-dot';
    riskLabel.appendChild(riskDot);
    riskLabel.appendChild(document.createTextNode(t[lang].scenarioRisk[scenario.risk]));
    factAction.textContent = scenario.action;
    factPolicy.textContent = scenario.policy;
    factExecutor.textContent = decision.executor;
    decisionEvidence.replaceChildren();
    scenario.evidence[lang].forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = item;
      decisionEvidence.appendChild(li);
    });
    approveButton.hidden = scenario.decision !== 'review' || approvedInSimulation;
    approvalNote.hidden = !(approvedInSimulation && scenario.decision === 'review');
    approvalNote.textContent = t[lang].approvalRecorded;
    var receipt = {
      simulation: true,
      receipt_id: scenario.receiptId,
      surface: scenario.surface,
      action: scenario.action,
      policy: scenario.policy,
      decision: decisionKey === 'approved' ? 'allow-after-review' : scenario.decision,
      reason: scenario.reason[lang],
      executor_invoked: false,
      approval: approvedInSimulation && scenario.decision === 'review'
        ? { actor: 'demo-operator', outcome: 'approved-in-simulation-only' }
        : null,
      signature: 'none — illustrative object, not a real Trust Receipt'
    };
    receiptJson.textContent = JSON.stringify(receipt, null, 2);
    document.querySelectorAll('.scenario-option').forEach(function (button) {
      var selected = button.getAttribute('data-scenario') === selectedScenario;
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      var indicator = button.querySelector('.scenario-select');
      if (indicator) indicator.textContent = selected ? '●' : '○';
    });
  }

  document.querySelectorAll('.scenario-option').forEach(function (button) {
    button.addEventListener('click', function () {
      selectedScenario = button.getAttribute('data-scenario') || 'force-push';
      approvedInSimulation = false;
      renderScenario();
    });
  });

  document.getElementById('evaluate-button').addEventListener('click', function () {
    approvedInSimulation = false;
    renderScenario();
    var output = document.getElementById('decision-output');
    output.setAttribute('data-evaluated', 'true');
  });

  approveButton.addEventListener('click', function () {
    if (scenarioData[selectedScenario] && scenarioData[selectedScenario].decision === 'review') {
      approvedInSimulation = true;
      renderScenario();
    }
  });

  document.getElementById('copy-receipt').addEventListener('click', function () {
    copyText(receiptJson.textContent).then(function () {
      showCopyResult(document.getElementById('copy-receipt'), t[lang].copyOk);
    }).catch(function () {
      showCopyResult(document.getElementById('copy-receipt'), t[lang].copyFail);
    });
  });

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      copyText(button.getAttribute('data-copy') || '').then(function () {
        showCopyResult(button, t[lang].copyOk);
      }).catch(function () {
        showCopyResult(button, t[lang].copyFail);
      });
    });
  });

  function copyText(value) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value);
    }
    return Promise.reject(new Error('Clipboard API unavailable'));
  }

  function showCopyResult(button, label) {
    var original = button.getAttribute('data-original-label');
    if (!original) {
      original = button.textContent;
      button.setAttribute('data-original-label', original);
    }
    button.textContent = label;
    window.setTimeout(function () {
      button.textContent = button.id === 'copy-receipt' ? t[lang].copyReceipt : (button.textContent === t[lang].copyFail ? (lang === 'tr' ? '⧉' : '⧉') : (button.textContent === t[lang].copyOk ? '⧉' : original));
      button.removeAttribute('data-original-label');
    }, 1800);
  }

  window.addEventListener('huqan:language-change', function (event) {
    lang = event.detail && event.detail.lang === 'en' ? 'en' : 'tr';
    renderScenario();
  });
  renderScenario();
})();
