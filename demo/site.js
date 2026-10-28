'use strict';

(function () {
  var lang = 'tr';
  var activeStep = 0;
  var t = window.HUQANI18N;

  var steps = document.querySelectorAll('.step-tab');
  var stepTitle = document.getElementById('step-title');
  var stepDescription = document.getElementById('step-description');
  var stepNumber = document.getElementById('step-number');
  var stepChips = document.getElementById('step-chips');
  var stepFile = document.getElementById('step-file');
  var langToggle = document.getElementById('language-toggle');
  var menuToggle = document.getElementById('menu-toggle');
  var topNav = document.querySelector('.top-nav');

  function number(value) {
    try { return new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US').format(value); }
    catch (error) { return String(value); }
  }

  function applyLanguage(nextLang) {
    lang = nextLang === 'en' ? 'en' : 'tr';
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-tr][data-en]').forEach(function (element) {
      element.textContent = element.getAttribute('data-' + lang);
    });
    langToggle.textContent = lang === 'tr' ? 'EN' : 'TR';
    langToggle.setAttribute('aria-label', lang === 'tr' ? 'Switch language to English' : 'Dili Türkçeye geçir');
    document.title = t[lang].title;
    window.HUQANI18N.setLanguage(lang);
    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', t[lang].description);
    window.dispatchEvent(new CustomEvent('huqan:language-change', { detail: { lang: lang } }));
    renderStep(activeStep);
  }

  langToggle.addEventListener('click', function () {
    applyLanguage(lang === 'tr' ? 'en' : 'tr');
  });

  menuToggle.addEventListener('click', function () {
    var open = menuToggle.getAttribute('aria-expanded') !== 'true';
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    topNav.classList.toggle('is-open', open);
    menuToggle.setAttribute('aria-label', open ? (lang === 'tr' ? 'Menüyü kapat' : 'Close menu') : (lang === 'tr' ? 'Menüyü aç' : 'Open menu'));
  });

  topNav.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      topNav.classList.remove('is-open');
      menuToggle.setAttribute('aria-expanded', 'false');
    });
  });

  function renderStep(index) {
    activeStep = Math.max(0, Math.min(3, Number(index) || 0));
    steps.forEach(function (button, i) {
      var selected = i === activeStep;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    stepNumber.textContent = '0' + (activeStep + 1) + ' / 04';
    stepTitle.textContent = t[lang].stepTitles[activeStep];
    stepDescription.textContent = t[lang].stepDescriptions[activeStep];
    stepFile.textContent = t[lang].stepFiles[activeStep];
    stepChips.replaceChildren();
    t[lang].stepChips[activeStep].forEach(function (label) {
      var chip = document.createElement('span');
      chip.textContent = label;
      stepChips.appendChild(chip);
    });
  }

  steps.forEach(function (button, index) {
    button.addEventListener('click', function () { renderStep(index); });
    button.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      var next = index;
      if (event.key === 'ArrowDown') next = (index + 1) % steps.length;
      if (event.key === 'ArrowUp') next = (index + steps.length - 1) % steps.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = steps.length - 1;
      steps[next].focus();
      renderStep(next);
    });
  });

  var progressBar = document.getElementById('reading-progress-bar');
  function updateProgress() {
    var doc = document.documentElement;
    var maxScroll = doc.scrollHeight - window.innerHeight;
    var percentage = maxScroll > 0 ? Math.min(100, Math.max(0, window.scrollY / maxScroll * 100)) : 0;
    progressBar.style.width = percentage + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);
  updateProgress();

  renderStep(0);
})();
