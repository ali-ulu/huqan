'use strict';

const I18N_STORAGE_KEY = 'huqan-locale';
const SUPPORTED_LOCALES = ['tr', 'en'];
const DEFAULT_LOCALE = 'tr';

let currentLocale = DEFAULT_LOCALE;
let messages = {};
let isInitialized = false;

async function loadLocale(locale) {
  try {
    const response = await fetch(`/locales/${locale}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load locale: ${locale}`);
    return await response.json();
  } catch (error) {
    console.error(`[i18n] Failed to load locale ${locale}:`, error);
    return null;
  }
}

function getStoredLocale() {
  try {
    const stored = localStorage.getItem(I18N_STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      return stored;
    }
  } catch (e) {
    // localStorage not available
  }
  return null;
}

function setStoredLocale(locale) {
  try {
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  } catch (e) {
    // localStorage not available
  }
}

function detectBrowserLocale() {
  const browserLang = navigator.language || navigator.userLanguage || '';
  const lang = browserLang.split('-')[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;
}

function resolveLocale() {
  const stored = getStoredLocale();
  if (stored) return stored;
  return detectBrowserLocale();
}

function t(key, params = {}) {
  const keys = key.split('.');
  let value = messages;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      console.warn(`[i18n] Missing translation key: ${key} (locale: ${currentLocale})`);
      return key;
    }
  }

  if (typeof value !== 'string') {
    console.warn(`[i18n] Translation key ${key} is not a string (locale: ${currentLocale})`);
    return key;
  }

  return value.replace(/\{(\w+)\}/g, (match, param) => {
    return params[param] !== undefined ? params[param] : match;
  });
}

function tSafe(key, params = {}) {
  const keys = key.split('.');
  let value = messages;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return null;
    }
  }

  if (typeof value !== 'string') return null;

  return value.replace(/\{(\w+)\}/g, (match, param) => {
    return params[param] !== undefined ? params[param] : match;
  });
}

function hasKey(key) {
  const keys = key.split('.');
  let value = messages;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return false;
    }
  }

  return typeof value === 'string';
}

function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    console.warn(`[i18n] Unsupported locale: ${locale}`);
    return false;
  }
  currentLocale = locale;
  setStoredLocale(locale);
  document.documentElement.lang = locale;
  return true;
}

async function initI18n() {
  if (isInitialized) return currentLocale;

  const locale = resolveLocale();
  currentLocale = locale;

  messages = await loadLocale(locale);
  if (!messages) {
    console.error(`[i18n] Failed to load locale ${locale}, falling back to ${DEFAULT_LOCALE}`);
    currentLocale = DEFAULT_LOCALE;
    messages = await loadLocale(DEFAULT_LOCALE);
    if (!messages) {
      throw new Error(`[i18n] Critical: Failed to load default locale ${DEFAULT_LOCALE}`);
    }
  }

  document.documentElement.lang = currentLocale;
  setStoredLocale(currentLocale);
  isInitialized = true;

  applyTranslations();
  updateLocaleUI();

  return currentLocale;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.dataset.i18n;
    const translation = t(key);
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      if (element.type === 'password') return;
      element.placeholder = translation;
    } else if (element.tagName === 'OPTION') {
      element.textContent = translation;
    } else {
      element.textContent = translation;
    }
  });

  document.querySelectorAll('[data-i18n-html]').forEach(element => {
    const key = element.dataset.i18nHtml;
    element.innerHTML = t(key);
  });

  document.querySelectorAll('[data-i18n-attr]').forEach(element => {
    const attrMap = element.dataset.i18nAttr;
    if (!attrMap) return;
    const pairs = attrMap.split(',');
    for (const pair of pairs) {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) {
        element.setAttribute(attr, t(key));
      }
    }
  });
}

function updateLocaleUI() {
  const selector = document.getElementById('locale-selector');
  if (selector) {
    selector.value = currentLocale;
  }
}

function setupLocaleSelector() {
  const selector = document.getElementById('locale-selector');
  if (!selector) return;

  selector.addEventListener('change', async (e) => {
    const newLocale = e.target.value;
    if (newLocale === currentLocale) return;

    const oldLocale = currentLocale;
    setLocale(newLocale);

    const newMessages = await loadLocale(newLocale);
    if (!newMessages) {
      console.error(`[i18n] Failed to load locale ${newLocale}, reverting to ${oldLocale}`);
      messages = await loadLocale(oldLocale);
      selector.value = oldLocale;
      return;
    }

    messages = newMessages;
    applyTranslations();
    window.dispatchEvent(new CustomEvent('huqan-locale-change', { detail: { locale: newLocale } }));
  });
}

function getCurrentLocale() {
  return currentLocale;
}

function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

// Window export for global access — both app.js (plain script) and module
if (typeof window !== 'undefined') {
  window.HUQAN_I18N = {
    initI18n,
    t,
    tSafe,
    hasKey,
    setLocale,
    getCurrentLocale,
    getSupportedLocales,
    setupLocaleSelector,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE
  };
}
