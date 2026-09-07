'use strict';

/**
 * #1931: dismissible first-run onboarding checklist.
 *
 * Progress is browser-local and carries nothing but the ids of the steps that
 * were completed plus whether the card was skipped -- never the API key, the
 * workspace, or any receipt content.
 *
 * A step completes only when its underlying action really succeeded. Each
 * wrapper awaits the handler app.js already owns and then reads the status
 * element that handler writes, which carries `good` on a successful response
 * and `bad` (or nothing) otherwise. Clicking a button whose request fails
 * leaves the step open, so the checklist tracks outcomes, not clicks.
 *
 * The card is an inline panel on Home, never a modal or a gate: a returning
 * user with saved progress simply sees it collapsed behind a reopen button.
 */
(() => {
  // Resolved through app.js when the page loads it, and by the fallback when
  // this module runs on its own — a unit test, or before app.js has executed.
  const T = (key, fallback, params) => (typeof window !== 'undefined' && window.HUQAN_T ? window.HUQAN_T(key, fallback, params) : fallback);
  const STORAGE_KEY = 'huqan-onboarding';
  const VERSION = 1;
  const STEPS = [
    {
      id: 'session',
      titleKey: 'onboarding.steps.session.title', title: 'Connect your workspace session',
      hintKey: 'onboarding.steps.session.hint', hint: 'Save the API key and workspace, then reach the runtime surfaces.',
      view: 'settings',
      ctaKey: 'onboarding.steps.session.cta', cta: 'Open Settings',
    },
    {
      id: 'read',
      titleKey: 'onboarding.steps.read.title', title: 'Run one read workflow',
      hintKey: 'onboarding.steps.read.hint', hint: 'Verify a claim or ask a question and get a source-backed answer.',
      view: 'verify',
      ctaKey: 'onboarding.steps.read.cta', cta: 'Open Verify',
    },
    {
      id: 'evidence',
      titleKey: 'onboarding.steps.evidence.title', title: 'Open the evidence behind an answer',
      hintKey: 'onboarding.steps.evidence.hint', hint: 'Look up the Trust Receipt that records how the answer was reached.',
      view: 'evidence',
      ctaKey: 'onboarding.steps.evidence.cta', cta: 'Open Evidence',
    },
  ];
  const STEP_IDS = STEPS.map(step => step.id);

  /** Accepts whatever survived in storage and returns a trusted shape. */
  function normalizeProgress(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const claimed = Array.isArray(source.done) ? source.done : [];
    const done = STEP_IDS.filter(id => claimed.includes(id));
    return { done, dismissed: source.dismissed === true };
  }

  /** The only shape ever written back: step ids and a skip flag. */
  function progressPayload(progress) {
    return {
      version: VERSION,
      done: STEP_IDS.filter(id => progress.done.includes(id)),
      dismissed: progress.dismissed === true,
    };
  }

  /**
   * app.js marks a successful action by putting `good` on the status element
   * it owns; a failure puts `bad` there instead. Reading that class is how a
   * step learns the action actually worked.
   */
  function succeeded(element) {
    return String(element && element.className || '').split(/\s+/).includes('good');
  }

  function checklistComplete(progress) {
    return STEP_IDS.every(id => progress.done.includes(id));
  }

  function stepState(progress, id) {
    if (progress.done.includes(id)) return 'done';
    const open = STEP_IDS.filter(candidate => !progress.done.includes(candidate));
    return open[0] === id ? 'next' : 'todo';
  }

  let progress = { done: [], dismissed: false };

  function load() {
    try {
      return normalizeProgress(JSON.parse(window.localStorage.getItem(STORAGE_KEY)));
    } catch (_) {
      return normalizeProgress(null);
    }
  }

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progressPayload(progress)));
    } catch (_) {
      // A browser refusing storage must not break the dashboard; the checklist
      // simply restarts on the next visit.
    }
  }

  const $ = id => document.getElementById(id);
  const card = $('onboard');
  const reopenWrap = $('onboardreopenwrap');
  const list = $('onboardsteps');
  const progressText = $('onboardprogress');

  function render() {
    const complete = checklistComplete(progress);
    const collapsed = complete || progress.dismissed;
    card.hidden = collapsed;
    reopenWrap.hidden = !collapsed;
    progressText.textContent = T('onboarding.progress', `${progress.done.length} of ${STEP_IDS.length} done`, { done: progress.done.length, total: STEP_IDS.length });
    list.textContent = '';
    for (const step of STEPS) {
      const state = stepState(progress, step.id);
      const row = document.createElement('li');
      row.className = `onboardstep ${state}`;
      row.dataset.step = step.id;
      row.dataset.state = state;

      const mark = document.createElement('i');
      mark.className = 'onboardmark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = state === 'done' ? '✓' : '○';

      const copy = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = T(step.titleKey, step.title);
      const hint = document.createElement('span');
      hint.textContent = T(step.hintKey, step.hint);
      copy.append(title, hint);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = state === 'next' ? 'btn primary' : 'btn';
      action.textContent = T(step.ctaKey, step.cta);
      action.disabled = state === 'done';
      action.addEventListener('click', () => window.go(step.view));

      row.append(mark, copy, action);
      list.append(row);
    }
  }

  function completeStep(id) {
    if (progress.done.includes(id)) return;
    progress = { ...progress, done: [...progress.done, id] };
    persist();
    render();
  }

  /**
   * Re-binds the button app.js wired with `.onclick`, calls the original
   * handler, and only then asks the status element whether it worked.
   */
  function trackAction(buttonId, handlerName, statusId, stepId) {
    const button = $(buttonId);
    const original = window[handlerName];
    if (!button || typeof original !== 'function') return;
    button.onclick = async event => {
      try {
        await original(event);
      } finally {
        if (succeeded($(statusId))) completeStep(stepId);
      }
    };
  }

  $('onboardskip').addEventListener('click', () => {
    progress = { ...progress, dismissed: true };
    persist();
    render();
  });

  $('onboardreset').addEventListener('click', () => {
    progress = { done: [], dismissed: false };
    persist();
    render();
  });

  $('onboardreopen').addEventListener('click', () => {
    progress = { ...progress, dismissed: false };
    persist();
    render();
    card.hidden = false;
    reopenWrap.hidden = true;
  });

  trackAction('save', 'save', 'sstatus', 'session');
  trackAction('run', 'run', 'vstatus', 'read');
  trackAction('eload', 'loadReceipt', 'estatus', 'evidence');

  $('homehero').after(card);
  card.after(reopenWrap);
  progress = load();
  render();

  // The checklist builds its rows in script, so applyTranslations never sees
  // them. It has to redraw itself when the catalogue lands and when the reader
  // picks a different language. Guarded because the module is also exercised
  // against a minimal window stub that carries no event target.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('huqan-i18n-ready', render);
    window.addEventListener('huqan-locale-change', render);
  }
})();
