'use strict';

(() => {
  // Resolved through app.js when the page loads it, and by the fallback when
  // this module runs on its own — a unit test, or before app.js has executed.
  const T = (key, fallback, params) => (typeof window !== 'undefined' && window.HUQAN_T ? window.HUQAN_T(key, fallback, params) : fallback);
  const offlineBanner = document.getElementById('offline-banner');
  const installButton = document.getElementById('install-app');
  const installStatus = document.getElementById('install-app-status');
  let installPrompt = null;

  function setConnectivity(online) {
    offlineBanner.hidden = online;
    document.documentElement.dataset.connectivity = online ? 'online' : 'offline';
  }

  async function probeRuntime() {
    if (navigator.onLine === false) {
      setConnectivity(false);
      return;
    }
    try {
      const response = await fetch('/health', { cache: 'no-store', credentials: 'omit' });
      setConnectivity(response.ok);
    } catch (_) {
      setConnectivity(false);
    }
  }

  window.addEventListener('online', probeRuntime);
  window.addEventListener('offline', () => setConnectivity(false));
  probeRuntime();

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    installButton.disabled = true;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice && choice.outcome === 'dismissed') {
        installStatus.textContent = T('pwa.dismissed', 'Installation was dismissed. Use the browser menu when you are ready.');
      }
    } catch (_) {
      installStatus.textContent = T('pwa.incomplete', 'Installation was not completed. Use the browser menu to try again.');
    } finally {
      installPrompt = null;
      installButton.disabled = false;
      installButton.hidden = true;
    }
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installButton.hidden = true;
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }).catch(() => {
      installStatus.textContent = T('pwa.unsupported', 'Offline mode is unavailable in this browser session.');
    });
  }
})();
