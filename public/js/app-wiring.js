'use strict';
// HUQAN dashboard wiring: element handlers, i18n, bootstrap.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
function clear(){sessionStorage.clear();
state.key='';
state.ws='default';
settings();
refresh()}
async function refresh(){Object.keys(state.surfaces).forEach(k=>surface(k,'checking'));
renderGraph();
await Promise.allSettled([loadStatus(),loadManifest(),loadGraph(),loadApprovals(),loadActivityPulse()]);
renderGraph();
renderApproval();
renderHealth()}
$('refresh').onclick=refresh;
$('agentpulserefresh').onclick=loadActivityPulse;
$('agentpulseopen').onclick=()=>openAgentActivity();
$('activitypulseitems').onclick=e=>{const row=e.target.closest('[data-activity-pulse-id]');
if(row)openAgentActivity(row.dataset.activityPulseId)}
;
$('activitypulseitems').onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;
const row=e.target.closest('[data-activity-pulse-id]');
if(!row)return;
e.preventDefault();
openAgentActivity(row.dataset.activityPulseId)}
;
$('arefresh').onclick=loadApprovals;
$('activityrefresh').onclick=()=>loadActivity(true);
$('activityapply').onclick=()=>loadActivity(true);
$('activitynext').onclick=()=>loadActivity(false);
$('activitylist').onclick=e=>{const receiptButton=e.target.closest('[data-activity-receipt]');
if(receiptButton){e.stopPropagation();
openActivityReceipt(receiptButton.dataset.activityReceipt);
return}
const row=e.target.closest('[data-activity-id]');
if(row)showActivity(row.dataset.activityId)}
;
$('activitylist').onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;
const row=e.target.closest('[data-activity-id]');
if(!row)return;
e.preventDefault();
showActivity(row.dataset.activityId)}
;
$('grefresh').onclick=loadGraph;
$('crefresh').onclick=loadGraph;
$('cseverity').onchange=e=>setConflictFilter('severity',e.target.value);
$('ctype').onchange=e=>setConflictFilter('type',e.target.value);
$('cclear').onclick=clearConflictFilters;
$('cmore').onclick=()=>{state.conflicts.limit+=CONFLICT_PAGE;
renderConflicts()}
;
$('cless').onclick=()=>{state.conflicts.limit=CONFLICT_PAGE;
renderConflicts()}
;
$('ctriage').onclick=e=>{const b=e.target.closest('[data-conflict-severity]');
if(!b)return;
setConflictFilter('severity',state.conflicts.filters.severity===b.dataset.conflictSeverity?'':b.dataset.conflictSeverity)}
;
$('run').onclick=run;
function actionFields(){agentFields();
ingestFields()}
$('action').onchange=actionFields;
$('ingestsource').onchange=actionFields;
actionFields();
$('review').onclick=review;
$('eload').onclick=loadReceipt;
$('recent').onclick=e=>{openReceipt(e.target.closest('[data-receipt]'))}
;
$('recent').onkeydown=e=>{if(e.key!=='Enter'&&e.key!==' ')return;
const n=e.target.closest('[data-receipt]');
if(!n)return;
e.preventDefault();
openReceipt(n)}
;
$('save').onclick=save;
$('clear').onclick=clear;
$('filebtn').onclick=()=>$('file').click();
$('file').onchange=e=>{const f=e.target.files?.[0];
if(!f)return;
if(!/\.(txt|md)$/i.test(f.name))return status(T('verify.errors.fileType','Only .txt and .md files are supported.'),1);
const r=new FileReader;
r.onload=()=>{$('prompt').value=String(r.result||'');
status(`${f.name} was read in the browser; no automatic upload was performed.`,0,true)}
;
r.readAsText(f,'utf-8');
e.target.value=''}
;
$('search').onkeydown=e=>{if(e.key!=='Enter')return;
const t=e.target.value.trim();
if(!t)return;
if(/^(rcpt_|madm_receipt_|receipt)/i.test(t)){$('einput').value=t;
go('evidence');
loadReceipt()}
else{$('prompt').value=t;
go('verify')}
}
;
async function probeAuthMode(){try{const r=await fetch('/health',{cache:'no-store'});
if(r.ok){const d=await r.json();
state.authRequired=d.apiAuthRequired!==false}
}
catch(e){}
}

// The catalogue arrives after this script has already painted, and it can be
// swapped again from the language selector. Both moments have to repaint the
// surfaces that were rendered from stored state, or the page keeps whichever
// language happened to win the initial race.
// Idle placeholders are the copy a panel shows until a read actually returns
// something — "Query a receipt.", "Waiting for a run ID.". They cannot carry
// data-i18n: applyTranslations would overwrite a result the reader is looking
// at. So each one is stamped with the text last written here, and refreshed
// only while it still shows exactly that. The moment a render path replaces it
// with real content the stamp stops matching and the element is left alone.
const idleNodes=()=>document.querySelectorAll('[data-i18n-idle]');

// Stamped synchronously, before any fetch can resolve: an element already
// filled by a render path must never be reset to its placeholder.
function stampIdle(){idleNodes().forEach(el=>{if(el.dataset.i18nIdleText===undefined)el.dataset.i18nIdleText=el.textContent})}

function applyIdle(){idleNodes().forEach(el=>{if(el.textContent!==el.dataset.i18nIdleText)return;const next=T(el.dataset.i18nIdle,el.textContent);el.textContent=next;el.dataset.i18nIdleText=next})}

stampIdle();

function relocalize(){try{clock();
applyIdle();
settings();
renderRecent();
renderHealth();
renderGraph();
renderApproval()}
catch(e){console.warn('[i18n] relocalize failed:',e)}
}

if(typeof window!=='undefined'){window.addEventListener('huqan-i18n-ready',relocalize);
window.addEventListener('huqan-locale-change',relocalize)}

probeAuthMode().finally(()=>{settings();renderRecent();renderHealth();refresh()});

