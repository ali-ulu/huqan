'use strict';

(() => {
  const hero = document.getElementById('homehero');
  const overview = document.getElementById('v-overview');
  overview.prepend(hero);

  const navigate = window.go;
  window.go = view => {
    navigate(view);
    hero.hidden = view !== 'overview';
    document.querySelectorAll('.nav button').forEach(button => {
      if (button.dataset.v === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  };
})();
