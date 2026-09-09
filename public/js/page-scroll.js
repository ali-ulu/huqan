'use strict';

(() => {
  const main = document.querySelector('main');
  const controls = document.createElement('div');
  controls.className = 'page-scroll-controls';
  controls.hidden = true;
  controls.innerHTML = '<button type="button" class="btn" data-scroll="top">⇈</button>'
    + '<button type="button" class="btn" data-scroll="up">↑</button>'
    + '<button type="button" class="btn" data-scroll="down">↓</button>';
  main.append(controls);
  const buttons = [...controls.querySelectorAll('button')];
  const labels = {
    top: () => T('pageScroll.top','Back to top'),
    up: () => T('pageScroll.up','Scroll up one screen'),
    down: () => T('pageScroll.down','Scroll down one screen'),
  };
  let frame = null;
  const activeView = () => main.querySelector('.view.active');
  function update() {
    frame = null;
    const view = activeView();
    const maximum = view ? Math.max(0, view.scrollHeight - view.clientHeight) : 0;
    controls.hidden = maximum < 2;
    for (const button of buttons) {
      const action = button.dataset.scroll;
      button.title = labels[action]();
      button.setAttribute('aria-label', labels[action]());
      button.setAttribute('aria-controls', view?.id || '');
      button.disabled = !view || (action === 'down' ? view.scrollTop >= maximum - 2 : view.scrollTop <= 1);
    }
    if (view && !view.hasAttribute('tabindex')) view.tabIndex = 0;
  }
  function schedule() { if (frame === null) frame = requestAnimationFrame(update); }
  controls.addEventListener('click', event => {
    const button = event.target.closest('button');
    const view = activeView();
    if (!button || button.disabled || !view) return;
    const action = button.dataset.scroll;
    const distance = Math.max(100, view.clientHeight * 0.8);
    view.scrollTo({ top: action === 'top' ? 0 : view.scrollTop + (action === 'up' ? -distance : distance),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
  main.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('huqan-i18n-ready', schedule);
  window.addEventListener('huqan-locale-change', schedule);
  new MutationObserver(records => {
    if (records.some(record => !controls.contains(record.target))) schedule();
  }).observe(main, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  update();
})();
