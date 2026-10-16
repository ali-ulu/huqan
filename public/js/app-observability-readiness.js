'use strict';
window.HUQAN_OBS_READINESS = ({byId,T,workspace}) => {
  // Observability readiness (#1825).
  //
  // The backend fails closed with a typed 503 when OBSERVABILITY_AUTHZ_POLICY
  // is absent, but the page used to render the full Runs/Events/Queue/Alert UI
  // regardless and only reported the failure afterwards -- so an unconfigured
  // deployment looked like an active dashboard that happened to be empty.
  //
  // Controls start disabled and are enabled only once a read actually
  // succeeds, so "active" is something the backend grants rather than
  // something the shell assumes.
  // The write path only. Refresh, the window select and the event filters stay
  // live: they are reads, and disabling them would remove the operator's way to
  // re-probe after fixing the configuration.
  const OBSERVABILITY_CONTROLS = [
    'obsgoal', 'obsmaxsteps', 'obsalertname', 'obsalertmetric',
    'obsalertoperator', 'obsalertthreshold', 'obsalertwindow',
  ];

  function observabilityFormButtons() {
    return ['obsqueueform', 'obsalertform']
      .map(id => byId(id)?.querySelector('button[type="submit"]'))
      .filter(Boolean);
  }

  function setObservabilityReadiness(ready, detail) {
    const banner = byId('obsreadiness');
    // Only touch controls this gate disabled, so pagination keeps owning the
    // disabled state of obsrunsnext / obseventnext.
    for (const id of OBSERVABILITY_CONTROLS) {
      const el = byId(id);
      if (!el) continue;
      if (ready) {
        if (el.dataset.obsGated === '1') { el.disabled = false; delete el.dataset.obsGated; }
      } else if (!el.disabled) {
        el.disabled = true;
        el.dataset.obsGated = '1';
      }
    }
    for (const button of observabilityFormButtons()) {
      if (ready) {
        if (button.dataset.obsGated === '1') { button.disabled = false; delete button.dataset.obsGated; }
      } else if (!button.disabled) {
        button.disabled = true;
        button.dataset.obsGated = '1';
      }
    }
    if (!banner) return;
    banner.hidden = Boolean(ready);
    banner.textContent = ready ? '' : detail;
  }

  function observabilityUnavailableDetail(error) {
    if (error?.code === 'OBSERVABILITY_AUTHORIZATION_UNAVAILABLE') {
      // Name the operator action. The value itself is never shown: the point is
      // that the deployment is unconfigured, not what the policy contains.
      // One literal, not a concatenation: the fallback has to be comparable to
      // the catalogue entry it stands in for, and a split string hides half of
      // it from that comparison.
      return T('observabilityStatus.unavailable.notConfigured', 'NOT CONFIGURED · Observability authorization is unavailable. Set OBSERVABILITY_AUTHZ_POLICY on the server and reconnect.');
    }
    if (error?.code === 'OBSERVABILITY_WORKSPACE_FORBIDDEN' || error?.code === 'OBSERVABILITY_PERMISSION_FORBIDDEN') {
      return T('observabilityStatus.unavailable.workspaceForbidden', 'UNAVAILABLE · This session has no observability membership for '
        + workspace() + '. Ask an administrator for access.', { workspace: workspace() });
    }
    if (error?.status === 401) {
      return T('observabilityStatus.unavailable.authRequired', 'UNAVAILABLE · Observability requires an authenticated session. Save an API key in Settings.');
    }
    const detail = error?.message || T('observability.unknownError', 'unknown error');
    return T('observabilityStatus.unavailable.generic', 'UNAVAILABLE · Observability could not be reached: ' + detail, { message: detail });
  }

  return {setObservabilityReadiness,observabilityUnavailableDetail};
};
