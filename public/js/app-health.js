'use strict';
// HUQAN dashboard health: runtime surfaces and the aggregate.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>go(b.dataset.v));
document.addEventListener('click',e=>{const b=e.target.closest('[data-go],[data-action]');if(!b)return;if(b.dataset.action==='refresh'){refresh();return}if(b.dataset.action==='conflicts-clear'){clearConflictFilters();return}if(b.dataset.go)go(b.dataset.go)});
function surfaceTime(v){return v?new Intl.DateTimeFormat(locale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(v)):T('runtime.notChecked','not checked')}
function surfaceLabel(s){return s==='ok'?T('status.live','LIVE'):s==='locked'?T('status.locked','LOCKED'):s==='err'?T('status.error','ERROR'):s==='empty'?T('status.empty','EMPTY'):T('status.checking','CHECKING')}
function surfaceReason(k,s){return s==='locked'?M('runtime.reason.locked','API key required to read this surface.'):s==='err'?M('runtime.reason.error','The surface could not be loaded.'):s==='empty'?k==='graph'?M('runtime.reason.graphEmpty','The graph endpoint returned no nodes or relations.'):M('runtime.reason.empty','No records are available in this workspace.'):s==='checking'?M('runtime.reason.checking','Waiting for the first response.'):M('runtime.reason.ok','Response received from the runtime surface.')}
function surfaceAction(k,s){return s==='locked'?'settings':s==='empty'&&(k==='graph'||k==='approvals')?'verify':s==='err'?'refresh':null}
function surface(k,s,detail={}){const x=state.surfaces[k];
if(!x)return;
x.s=s;
if(s!=='checking')x.lastChecked=detail.lastChecked||Date.now();
x.reason=detail.reason||surfaceReason(k,s);
x.nextAction=detail.nextAction||surfaceAction(k,s)||M('common.refresh','Refresh');
renderHealth()}
function surfaceCta(k){const x=state.surfaces[k];
if(x.s==='locked')return`<button class="btn" type="button" data-go="settings">${esc(T('onboarding.steps.session.cta','Open Settings'))}</button>`;
if(x.s==='empty'&&k==='graph')return`<button class="btn primary" type="button" data-go="verify">${esc(T('home.verify','Verify a claim'))}</button>`;
if(x.s==='empty'&&k==='approvals')return`<button class="btn primary" type="button" data-go="verify">${esc(T('verify.form.actions.review','Send for review'))}</button>`;
if(x.s==='err')return`<button class="btn" type="button" data-action="refresh">${esc(T('common.retry','Retry'))}</button>`;
return''}
function aggregateStatus(surfaces){const a=Object.values(surfaces),online=a.filter(x=>x.s==='ok').length,total=a.length,hasError=a.some(x=>x.s==='err'),checking=a.some(x=>x.s==='checking');
let label='PARTIAL';
if(online===total)label='HEALTHY';
else if(online===0&&checking)label='CHECKING';
else if(online===0)label='OFFLINE';
else if(hasError)label='DEGRADED';
const locked=a.some(x=>x.s==='locked');
const recovery=locked?{kind:'settings'}
:hasError||label==='OFFLINE'?{kind:'refresh'}
:label==='PARTIAL'?{kind:'surfaces'}
:label==='CHECKING'?{kind:'refresh'}
:null;
const message=locked?M('runtime.health.locked','Some surfaces are locked — an API key is required.'):hasError?M('runtime.health.error','At least one surface failed to load.'):label==='OFFLINE'?M('runtime.health.offline','No surfaces responded.'):label==='CHECKING'?M('runtime.health.checking','Checking surfaces — results have not come back yet.'):label==='PARTIAL'?M('runtime.health.partial','Some surfaces are not live yet.'):M('runtime.health.ok','All surfaces are live.');
const nextAction=locked?M('runtime.next.locked','Open Settings and add your API key.'):hasError?M('runtime.next.error','Retry the failed surfaces.'):label==='OFFLINE'?M('runtime.next.offline','Retry all surfaces.'):label==='CHECKING'?M('runtime.next.checking','Wait a moment, then refresh.'):label==='PARTIAL'?M('runtime.next.partial','Open Surfaces to review each one.'):M('runtime.next.ok','Refresh anytime.');

// label stays the untranslated state token: it drives CSS tone selection and
// the comparisons above. Only its display copy is localised, at render time.
const labelText=label==='HEALTHY'?T('status.healthy','HEALTHY'):label==='PARTIAL'?T('status.partial','PARTIAL'):label==='CHECKING'?T('status.checking','CHECKING'):label==='OFFLINE'?T('status.offline','OFFLINE'):T('status.degraded','DEGRADED');
return{label,labelText,online,total,message,nextAction,recovery}
}
function renderHealth(){const a=Object.values(state.surfaces),aggregate=aggregateStatus(state.surfaces),n=aggregate.online,p=Math.round(n/a.length*100),tone=aggregate.label==='HEALTHY'?'ok':aggregate.label==='PARTIAL'?'locked':aggregate.label==='CHECKING'?'':'err',color=tone==='ok'?'var(--good)':tone==='locked'?'var(--warn)':tone==='err'?'var(--bad)':'var(--muted)';
$('score').textContent=`${n}/${a.length}`;
$('wheel').style.setProperty('--n',p);
$('wheel').setAttribute('aria-label',`${n} of ${a.length} ${T('rail.surfacesOnline','surfaces online')}`);
$('healthsum').textContent=`${aggregate.labelText} · ${Tx(aggregate.message)}`;
$('healthsum').className='state '+tone;
$('sys').textContent=aggregate.labelText;
$('sys').style.color=color;
$('sysdot').style.background=color;
$('footstatus').textContent=`${aggregate.labelText} · ${Tx(aggregate.message)}`;
$('footstatus').style.color=color;
$('footdot').style.background=color;
const rcta=aggregate.recovery?`<button type="button" class="btn" ${aggregate.recovery.kind==='settings'?'data-go="settings"':aggregate.recovery.kind==='surfaces'?'data-go="integrations"':'data-action="refresh"'}>${esc(aggregate.recovery.kind==='settings'?T('onboarding.steps.session.cta','Open Settings'):aggregate.recovery.kind==='surfaces'?T('runtime.openSurfaces','Open Surfaces'):aggregate.label==='CHECKING'?T('common.refresh','Refresh'):T('common.retry','Retry'))}</button>`:'';
$('healthcta').innerHTML=rcta;
$('footcta').innerHTML=rcta;
$('matrix').innerHTML=a.map(x=>`<div><span>${esc(Tx(x.label))}</span><b style="color:${x.s==='ok'?'var(--good)':x.s==='locked'?'var(--warn)':x.s==='err'?'var(--bad)':'var(--muted)'}">${esc(surfaceLabel(x.s))}</b></div>`).join('');
$('health').innerHTML=a.map(x=>`<div><span>${esc(Tx(x.label))}</span><b style="color:${x.s==='ok'?'var(--good)':x.s==='locked'?'var(--warn)':x.s==='err'?'var(--bad)':'var(--muted)'}">● ${esc(surfaceLabel(x.s))}</b></div>`).join('');
renderSurfaces()}
function renderSurfaces(){const d={status:T('runtime.surfaceDesc.status','Reads kernel, version, and runtime status.'),workflows:T('runtime.surfaceDesc.workflows','UI workflow capability manifest and route contract.'),graph:T('runtime.surfaceDesc.graph','Workspace-scoped graph node/relation surface.'),approvals:T('runtime.surfaceDesc.approvals','Authenticated human-review ingest queue.'),activity:T('runtime.surfaceDesc.activity','Workspace-scoped bounded agent activity read surface.')}
;
$('surfaces').innerHTML=Object.entries(state.surfaces).map(([k,x])=>`<div class="surface"><div><b>${esc(Tx(x.label))}</b><span class="state ${x.s==='ok'?'ok':x.s==='locked'?'locked':x.s==='err'?'err':''}">${esc(surfaceLabel(x.s))}</span></div><p><code>${esc(x.endpoint)}</code><br>${esc(d[k])}<br><b>${esc(T('runtime.field.status','Status:'))}</b> ${esc(surfaceLabel(x.s))} · <b>${esc(T('runtime.field.reason','Reason:'))}</b> ${esc(Tx(x.reason))}<br><b>${esc(T('runtime.field.lastChecked','Last checked:'))}</b> ${esc(surfaceTime(x.lastChecked))} · <b>${esc(T('runtime.field.next','Next:'))}</b> ${esc(Tx(x.nextAction))}</p><div class="actions">${surfaceCta(k)}</div></div>`).join('')}
async function loadStatus(){try{const{r,d}
=await json('/v2-status');
if(!r.ok)throw 0;
surface('status','ok',{reason:M('runtime.fetched.status','Runtime status fetched.'),nextAction:M('common.refresh','Refresh')});
$('mkernel').textContent=d.activeKernel||d.backend||'active';
$('mversion').textContent=`version ${d.version||'?'}`;
$('node').textContent=String(d.activeKernel||'HUQAN LOCAL').toUpperCase();
$('sync').textContent=`Last sync: ${$('clock').textContent}`}
catch{surface('status','err',{reason:M('runtime.failed.status','Runtime status request failed.'),nextAction:M('common.retry','Retry')});
$('mkernel').textContent='offline'}
}
