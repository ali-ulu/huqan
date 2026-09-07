const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');
const I18N_JS_PATH = path.join(__dirname, '..', 'public', 'js', 'i18n.js');

function loadLocale(name) {
  const content = fs.readFileSync(path.join(LOCALES_DIR, `${name}.json`), 'utf8');
  return JSON.parse(content);
}

function collectKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const subKey of collectKeys(value, fullKey)) {
        keys.add(subKey);
      }
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

function collectAllKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.add(fullKey);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const subKey of collectKeys(value, fullKey)) {
        keys.add(subKey);
      }
    }
  }
  return keys;
}

const SUPPORTED_LOCALES = ['tr', 'en'];
const EXPECTED_KEYS = [
  'app.title', 'app.brand', 'app.subtitle',
  'nav.overview', 'nav.overviewDesc', 'nav.verify', 'nav.verifyDesc',
  'nav.approvals', 'nav.approvalsDesc', 'nav.evidence', 'nav.evidenceDesc',
  'nav.observability', 'nav.observabilityDesc', 'nav.activity', 'nav.activityDesc',
  'nav.graph', 'nav.graphDesc', 'nav.conflicts', 'nav.conflictsDesc',
  'nav.integrations', 'nav.integrationsDesc', 'nav.settings', 'nav.settingsDesc',
  'header.systemStatus', 'header.searchPlaceholder', 'header.searchLabel', 'header.node', 'header.time',
  'secure.title', 'secure.apiKeyRequired',
  'overview.eyebrow', 'overview.title', 'overview.description', 'overview.refresh',
  'overview.metrics.graphNodes', 'overview.metrics.graphNodesDesc',
  'overview.metrics.relations', 'overview.metrics.relationsDesc',
  'overview.metrics.pendingReview', 'overview.metrics.pendingReviewDesc',
  'overview.metrics.kernel', 'overview.metrics.version',
  'overview.mesh.title', 'overview.mesh.subtitle', 'overview.mesh.badgeState', 'overview.mesh.badgeDesc',
  'overview.activeNodes.title', 'overview.activeNodes.viewAll', 'overview.activeNodes.empty',
  'overview.health.title', 'overview.health.state',
  'overview.activityPulse.title', 'overview.activityPulse.empty',
  'verify.eyebrow', 'verify.title', 'verify.description', 'verify.workflowState',
  'verify.console.title', 'verify.console.contract',
  'verify.form.workflowLabel', 'verify.form.workflows.verify', 'verify.form.workflows.ask',
  'verify.form.workflows.advocate', 'verify.form.workflows.memorySearch',
  'verify.form.workflows.agentPlan', 'verify.form.workflows.agentRun',
  'verify.form.promptLabel', 'verify.form.promptPlaceholder',
  'verify.form.stepsLabel', 'verify.form.steps.1', 'verify.form.steps.2',
  'verify.form.steps.4', 'verify.form.steps.6', 'verify.form.steps.8',
  'verify.form.actions.run', 'verify.form.actions.fileBtn', 'verify.form.actions.review',
  'verify.form.status',
  'verify.result.title', 'verify.result.subtitle', 'verify.result.empty',
  'approvals.eyebrow', 'approvals.title', 'approvals.description', 'approvals.refresh',
  'approvals.pending.title', 'approvals.pending.subtitle', 'approvals.pending.empty',
  'evidence.eyebrow', 'evidence.title', 'evidence.description',
  'evidence.lookup.title', 'evidence.lookup.subtitle', 'evidence.lookup.modeLabel',
  'evidence.lookup.modes.targetId', 'evidence.lookup.modes.receiptId',
  'evidence.lookup.modes.sourceRef', 'evidence.lookup.modes.provenanceId',
  'evidence.lookup.inputLabel', 'evidence.lookup.inputPlaceholder',
  'evidence.lookup.loadBtn', 'evidence.lookup.status', 'evidence.lookup.summary.status',
  'evidence.raw.title', 'evidence.raw.subtitle', 'evidence.raw.empty',
  'observability.eyebrow', 'observability.title', 'observability.description',
  'observability.windowFilter', 'observability.windows.1h', 'observability.windows.24h',
  'observability.windows.7d', 'observability.windows.31d', 'observability.refresh',
  'observability.metrics.totalRuns', 'observability.metrics.totalRunsDesc',
  'observability.metrics.successRate', 'observability.metrics.successRateDesc',
  'observability.metrics.p95Latency', 'observability.metrics.p95LatencyDesc',
  'observability.metrics.tokens', 'observability.metrics.tokensDesc',
  'observability.metrics.cost', 'observability.metrics.costDesc',
  'observability.metrics.queueDepth', 'observability.metrics.queueDepthDesc',
  'observability.toolUsage.title', 'observability.toolUsage.subtitle', 'observability.toolUsage.total',
  'observability.status',
  'observability.events.loading', 'observability.events.loadingNext',
  'observability.events.loadError', 'observability.events.summary',
  'observability.events.nextPage', 'observability.events.boundedPage', 'observability.events.empty',
  'observability.runs.empty', 'observability.runs.toolText', 'observability.runs.nextPage',
  'observability.runs.boundedPage', 'observability.runs.loadError',
  'observability.queue.empty', 'observability.queue.attempts', 'observability.queue.goalChars',
  'observability.queue.error',
  'observability.alerts.empty', 'observability.alerts.error',
  'observability.forms.queueGoalPlaceholder', 'observability.forms.alertMetric',
  'observability.forms.alertOperator', 'observability.forms.operators.gt',
  'observability.forms.operators.lt', 'observability.forms.operators.eq',
  'observability.forms.createAlert', 'observability.forms.queue', 'observability.forms.loadMore',
  'observability.toolUsage.unavailable', 'observability.toolUsage.unattributed', 'observability.toolUsage.totalMismatch',
  'observabilityStatus.checking', 'observabilityStatus.loading', 'observabilityStatus.ready',
  'observabilityStatus.error', 'observabilityStatus.reconnect',
  'observabilityStatus.unavailable.notConfigured', 'observabilityStatus.unavailable.workspaceForbidden',
  'observabilityStatus.unavailable.authRequired', 'observabilityStatus.unavailable.generic',
  'graph.eyebrow', 'graph.title', 'graph.description', 'graph.refresh',
  'graph.relations.title', 'graph.relations.count', 'graph.relations.empty',
  'conflicts.eyebrow', 'conflicts.title', 'conflicts.description', 'conflicts.refresh',
  'conflicts.signals.title', 'conflicts.signals.summary', 'conflicts.signals.empty',
  'integrations.eyebrow', 'integrations.title', 'integrations.description',
  'settings.eyebrow', 'settings.title', 'settings.description',
  'settings.workspace.title', 'settings.workspace.subtitle',
  'settings.workspace.apiKeyLabel', 'settings.workspace.apiKeyPlaceholder',
  'settings.workspace.workspaceLabel', 'settings.workspace.saveBtn', 'settings.workspace.clearBtn',
  'footer.status', 'footer.lastSync', 'footer.workspace', 'footer.tagline',
  'common.loading', 'common.error', 'common.retry', 'common.close', 'common.save',
  'common.cancel', 'common.delete', 'common.edit', 'common.view', 'common.search',
  'common.filter', 'common.clear', 'common.refresh', 'common.empty', 'common.none',
  'common.yes', 'common.no', 'common.enabled', 'common.disabled', 'common.active',
  'common.inactive', 'common.pending', 'common.approved', 'common.rejected',
  'common.failed', 'common.success', 'common.warning', 'common.info',
  'common.install', 'common.apply', 'common.dismiss',
  'status.checking', 'status.online', 'status.offline', 'status.degraded',
  'status.healthy', 'status.unhealthy', 'status.unknown',
  'validation.required', 'validation.invalidEmail', 'validation.minLength',
  'validation.maxLength', 'validation.patternMismatch',
  'emptyStates.noData', 'emptyStates.noResults', 'emptyStates.noApprovals',
  'emptyStates.noEvidence', 'emptyStates.noActivity', 'emptyStates.noConflicts',
  'emptyStates.noGraphData', 'emptyStates.noRuns', 'emptyStates.noEvents',
  'emptyStates.noQueue', 'emptyStates.noAlerts', 'emptyStates.noToolCalls',
  'onboarding.welcome', 'onboarding.subtitle', 'onboarding.step1',
  'onboarding.step2', 'onboarding.step3', 'onboarding.complete',
  'viewer.title', 'viewer.eyebrow', 'viewer.heading', 'viewer.lede',
  'viewer.access.title', 'viewer.access.apiKeyLabel', 'viewer.access.workspaceLabel',
  'viewer.access.workspaceHint', 'viewer.access.submitBtn', 'viewer.access.logoutBtn',
  'viewer.lookup.title', 'viewer.lookup.receiptIdLabel', 'viewer.lookup.workspaceLabel',
  'viewer.lookup.workspaceHint', 'viewer.lookup.submitBtn',
  'viewer.result.title', 'viewer.result.ready',
  'viewer.messages.unauthorized', 'viewer.messages.invalidRequest',
  'viewer.messages.notFound', 'viewer.messages.chainInvalid',
  'viewer.messages.readError', 'viewer.messages.found',
  'surfaces.countFormat', 'surfaces.checking',
  'surfaces.status.label', 'surfaces.status.reason', 'surfaces.status.endpoint', 'surfaces.status.nextAction',
  'surfaces.workflows.label', 'surfaces.workflows.reason', 'surfaces.workflows.endpoint', 'surfaces.workflows.nextAction',
  'surfaces.graph.label', 'surfaces.graph.reason', 'surfaces.graph.endpoint', 'surfaces.graph.nextAction',
  'surfaces.approvals.label', 'surfaces.approvals.reason', 'surfaces.approvals.endpoint', 'surfaces.approvals.nextAction',
  'surfaces.activity.label', 'surfaces.activity.reason', 'surfaces.activity.endpoint', 'surfaces.activity.nextAction',
  'locale.selector.tr', 'locale.selector.en',
  'pwa.install', 'pwa.installAria', 'pwa.installing', 'pwa.installed',
  'pwa.installTitle', 'pwa.installSubtitle', 'pwa.updateAvailable',
  'pwa.offline', 'pwa.cachedShell', 'pwa.liveUnavailable', 'pwa.details',
];

function createTestI18n({ navigator, storedLocale }) {
  const localStorageData = storedLocale ? { 'huqan-locale': storedLocale } : {};
  const document = {
    documentElement: { lang: '' },
    getElementById: () => null,
    querySelectorAll: () => []
  };

  const fetch = (url) => {
    const locale = url.split('/').pop().replace('.json', '');
    const data = loadLocale(locale);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data)
    });
  };

  const I18NSCRIPT = fs.readFileSync(I18N_JS_PATH, 'utf8');
  const windowMock = {};
  const sandbox = {
    window: windowMock,
    localStorage: {
      getItem: (key) => localStorageData[key] || null,
      setItem: (key, value) => { localStorageData[key] = value; },
    },
    navigator,
    document,
    fetch,
    console,
  };

  const vm = require('node:vm');
  const context = vm.createContext(sandbox);
  vm.runInContext(I18NSCRIPT, context, { filename: 'i18n.js' });

  return { i18n: windowMock.HUQAN_I18N, localStorageData, document };
}

test('i18n: both locale files are valid JSON', () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.doesNotThrow(() => loadLocale(locale), `${locale}.json should be valid JSON`);
  }
});

test('i18n: both locale files contain all required keys', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = loadLocale(locale);
    const allKeys = collectAllKeys(messages);

    for (const key of EXPECTED_KEYS) {
      assert.ok(allKeys.has(key), `${locale}.json is missing key: ${key}`);
    }
  }
});

test('i18n: no translation key returns the key itself (deterministic fallback)', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = loadLocale(locale);
    const allKeys = collectAllKeys(messages);

    for (const key of EXPECTED_KEYS) {
      assert.ok(allKeys.has(key), `${locale}.json is missing key: ${key} (fallback would return the key, not a translation)`);
    }
  }
});

test('i18n: all leaf values are non-empty strings', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = loadLocale(locale);

    function checkEmpty(obj, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          checkEmpty(value, fullKey);
        } else if (typeof value === 'string') {
          assert.ok(value.trim().length > 0, `${locale}.json has empty string at key: ${fullKey}`);
        } else {
          assert.fail(`${locale}.json has non-string value at key: ${fullKey}`);
        }
      }
    }

    checkEmpty(messages);
  }
});

test('i18n: locale files have the same key structure', () => {
  const trKeys = collectAllKeys(loadLocale('tr'));
  const enKeys = collectAllKeys(loadLocale('en'));

  const trOnly = [...trKeys].filter(k => !enKeys.has(k)).sort();
  const enOnly = [...enKeys].filter(k => !trKeys.has(k)).sort();

  assert.deepEqual(trOnly, [], `tr.json has keys not in en.json: ${trOnly.join(', ')}`);
  assert.deepEqual(enOnly, [], `en.json has keys not in tr.json: ${enOnly.join(', ')}`);
});

test('i18n: document.documentElement.lang follows setLocale', async () => {
  const { i18n, document } = createTestI18n({
    navigator: { language: 'en-US', userLanguage: '' },
    storedLocale: null,
  });

  assert.equal(document.documentElement.lang, '', 'lang should be empty before init');

  await i18n.initI18n();
  assert.equal(document.documentElement.lang, 'en', 'lang should be "en" (browser-pref) after init');

  i18n.setLocale('tr');
  assert.equal(document.documentElement.lang, 'tr', 'lang should be "tr" after setLocale');

  i18n.setLocale('en');
  assert.equal(document.documentElement.lang, 'en', 'lang should be "en" after setLocale back');
});

test('i18n: browser-local locale preference persisted', async () => {
  const { i18n, localStorageData } = createTestI18n({
    navigator: { language: 'tr-TR', userLanguage: '' },
    storedLocale: null,
  });

  await i18n.initI18n();

  assert.equal(localStorageData['huqan-locale'], 'tr', 'Turkish browser locale should be persisted to localStorage');

  i18n.setLocale('en');
  assert.equal(localStorageData['huqan-locale'], 'en', 'English should be persisted to localStorage on user switch');

  const { i18n: i18n2, document: doc2 } = createTestI18n({
    navigator: { language: 'en-US', userLanguage: '' },
    storedLocale: 'en',
  });

  await i18n2.initI18n();
  assert.equal(doc2.documentElement.lang, 'en', 'should load persisted English locale on re-init');
});

test('i18n: deterministic fallback never returns bare key as displayed text', () => {
  const tr = loadLocale('tr');
  const en = loadLocale('en');

  for (const key of EXPECTED_KEYS) {
    const trVal = getNested(tr, key);
    const enVal = getNested(en, key);
    if (trVal === key) {
      assert.fail(`tr.json returns bare key for ${key} — fallback would display the key itself`);
    }
    if (enVal === key) {
      assert.fail(`en.json returns bare key for ${key} — fallback would display the key itself`);
    }
  }

  function getNested(obj, key) {
    const parts = key.split('.');
    let val = obj;
    for (const p of parts) {
      if (val && typeof val === 'object' && p in val) {
        val = val[p];
      } else {
        return key;
      }
    }
    return typeof val === 'string' ? val : key;
  }
});
