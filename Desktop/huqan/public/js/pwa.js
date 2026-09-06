// ============ PWA: Install Affordance & Offline Handling ============
(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const t = (key, params) => window.HUQAN_I18N?.t(key, params) ?? key;
  let installPrompt = null;
  let isOffline = !navigator.onLine;

  function createInstallButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.id = 'pwa-install-btn';
    btn.style.display = 'none';
    btn.textContent = t('common.install');
    btn.setAttribute('aria-label', t('pwa.installAria'));
    return btn;
  }

  function createUpdateBanner() {
    const banner = document.createElement('div');
    banner.id = 'sw-update-banner';
    banner.style.cssText = `
      position: fixed;
      bottom: 44px;
      left: 50%;
      transform: translateX(-50%) translateY(120%);
      transition: transform .3s ease;
      z-index: 1000;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 14px;
      box-shadow: var(--shadow);
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 11px;
      color: var(--ink);
      backdrop-filter: blur(14px);
    `;
    banner.innerHTML = `
      <span>🔄 ${t('pwa.updateAvailable')}</span>
      <button class="btn primary" id="sw-update-reload" type="button" style="padding:6px 10px;font-size:10px;">${t('common.apply')}</button>
      <button class="btn" id="sw-update-dismiss" type="button" style="padding:6px 10px;font-size:10px;">${t('common.dismiss')}</button>
    `;
    return banner;
  }

  function createOfflineIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'offline-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 28px;
      background: linear-gradient(90deg, #ee5067, #f97316);
      color: #fff;
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-size: 11px;
      font-weight: 600;
      z-index: 1001;
      box-shadow: 0 4px 16px rgba(238,80,103,.3);
    `;
    indicator.innerHTML = `
      <span>📴 ${t('pwa.offline')} — ${t('pwa.cachedShell')}</span>
      <span style="font-size:10px;opacity:.9;">${t('pwa.liveUnavailable')} <a href="/offline.html" style="color:#fff;text-decoration:underline;">${t('pwa.details')}</a></span>
    `;
    return indicator;
  }

  function initPWA() {
    const installBtn = createInstallButton();
    const settingsPanel = document.querySelector('#v-settings .panel .pb');
    if (settingsPanel) {
      const installSection = document.createElement('div');
      installSection.style.marginTop = '16px';
      installSection.style.paddingTop = '16px';
      installSection.style.borderTop = '1px solid var(--line)';
      installSection.innerHTML = `
        <div class="ph"><b>${t('pwa.installTitle')}</b><small>${t('pwa.installSubtitle')}</small></div>
      `;
      installSection.appendChild(installBtn);
      settingsPanel.appendChild(installSection);
    }

    const updateBanner = createUpdateBanner();
    document.body.appendChild(updateBanner);

    const offlineIndicator = createOfflineIndicator();
    document.body.appendChild(offlineIndicator);

    window.addEventListener('install-available', e => {
      installPrompt = e.detail;
      installBtn.style.display = 'inline-flex';
      installBtn.setAttribute('aria-hidden', 'false');
    });

    window.addEventListener('app-installed', () => {
      installBtn.style.display = 'none';
      installBtn.setAttribute('aria-hidden', 'true');
      installPrompt = null;
    });

    installBtn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installBtn.disabled = true;
      installBtn.textContent = t('pwa Installing');
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') {
        installBtn.textContent = '✓ ' + t('pwa.installed');
        setTimeout(() => { installBtn.style.display = 'none'; }, 2000);
      } else {
        installBtn.disabled = false;
        installBtn.textContent = t('common.install');
      }
      installPrompt = null;
    });

    window.addEventListener('sw-update-available', e => {
      updateBanner.style.transform = 'translateX(-50%) translateY(0)';
      byId('sw-update-reload').onclick = () => {
        e.detail.update().then(() => window.location.reload());
      };
      byId('sw-update-dismiss').onclick = () => {
        updateBanner.style.transform = 'translateX(-50%) translateY(120%)';
      };
    });

    function updateOfflineUI() {
      isOffline = !navigator.onLine;
      offlineIndicator.style.display = isOffline ? 'flex' : 'none';
      document.body.style.paddingTop = isOffline ? '28px' : '0';

      const sysdot = byId('sysdot');
      const sys = byId('sys');
      if (!sysdot || !sys) return;

      if (isOffline) {
        sysdot.style.background = 'var(--bad)';
        sysdot.style.boxShadow = '0 0 0 4px #ee506715, 0 0 10px #ee506788';
        sys.textContent = t('status.offline');
        sys.style.color = 'var(--bad)';
      } else {
        sysdot.style.background = 'var(--good)';
        sysdot.style.boxShadow = '0 0 0 4px #16b77a15, 0 0 10px #16b77a88';
        sys.textContent = t('status.online');
        sys.style.color = 'var(--good)';
      }
    }

    window.addEventListener('online', updateOfflineUI);
    window.addEventListener('offline', updateOfflineUI);
    updateOfflineUI();

    if (document.documentElement.hasAttribute('data-offline-shell') ||
        (document.querySelector('meta[http-equiv="X-HUQAN-Offline-Shell"]'))) {
      isOffline = true;
      updateOfflineUI();
    }

    setInterval(async () => {
      if (isOffline) {
        try {
          await fetch('/', { method: 'HEAD', cache: 'no-store' });
          if (isOffline) {
            window.dispatchEvent(new Event('online'));
          }
        } catch (_) {}
      }
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPWA);
  } else {
    initPWA();
  }
})();
