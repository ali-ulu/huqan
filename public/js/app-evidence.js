'use strict';
// HUQAN dashboard evidence: receipt lookup and settings.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
function noEvidence(detail,x){if(detail||!x)return false;
return x.status==='unknown'&&!x.provenance&&!x.candidateClaim&&!x.canonical&&!(x.auditTrail||[]).length}

async function loadReceipt(){const v=$('einput').value.trim(),m=$('emode').value;
if(!v)return estatus(T('evidence.enterId','Enter a receipt or sourceRef.'),1);
estatus(T('evidence.loading','Loading evidence…'));
const detail=m==='receiptId'?capability('trust-receipt-detail'):null;
if(m==='receiptId'&&!detail?.availability?.ui)return estatus('trust-receipt-detail: capability_not_available',1);
const path=detail?routeFor(detail,{id:v}):null;
if(detail&&!path)return estatus('trust-receipt-detail: route_template_unsupported',1);
try{const url=detail?`${path}?workspaceId=${encodeURIComponent(state.ws)}`:`/api/trust-receipt?${new URLSearchParams({[m]:v,workspaceId:state.ws})}`;
const{r,d}
=await json(url,{headers:headers()});
if(!r.ok||!d.ok)throw Error(d?.error?.code||d?.error?.message||`HTTP ${r.status}`);
const data=detail?d.data?.receipt:(d.data||d.receipt||d);
if(!data)throw Error('receipt_projection_missing');
$('raw').textContent=JSON.stringify(data,null,2);
summary(data);
estatus(noEvidence(detail,data)?T('evidence.noEvidence','No evidence is recorded for this target. If this is a receipt id, switch Lookup Mode to receiptId.'):T('evidence.found','Receipt found.'),noEvidence(detail,data),!noEvidence(detail,data));
if(data?.receiptId)receipt(data.receiptId,data.claim||data.targetId||data.action,data.status)}
catch(e){$('raw').textContent='—';
summary();
estatus(`failed: ${e.message}`,1)}
}
function summary(x){const rows=x?[[T('evidence.rows.status','Status'),x.status||'unknown'],[T('evidence.rows.receiptId','Receipt ID'),x.receiptId||'—'],[T('evidence.rows.workspace','Workspace'),x.workspaceId||state.ws],[T('evidence.rows.target','Target'),x.targetId||'—'],[T('evidence.rows.confidence','Confidence'),x.confidence??'—'],[T('evidence.rows.canonical','Canonical'),x.canonical?T('evidence.values.yes','yes'):T('evidence.values.no','no')],[T('evidence.rows.policy','Policy'),x.trustPolicyVersion||'—']]:[[T('evidence.rows.status','Status'),'—']];
$('summary').innerHTML=rows.map(([a,b])=>`<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}
function estatus(t,bad=false,good=false){$('estatus').textContent=t;
$('estatus').className='status '+(bad?'bad':good?'good':'')}
function settings(){const open=!state.authRequired,ready=open||!!state.key;
$('keyfield').hidden=open;
$('key').value=state.key;
$('workspace').value=state.ws;
$('footws').textContent=T('footer.workspaceNamed',`Workspace: ${state.ws}`,{workspace:state.ws});
$('securetxt').textContent=`Workspace ${state.ws} · ${open?T('settings.authDisabled','API auth disabled on this server'):ready?T('settings.authenticatedSession','authenticated session'):T('secure.apiKeyRequired','API key required')}`;
$('securemeter').style.width=ready?'100%':'0%';
$('securemeter').parentElement.setAttribute('aria-label',ready?T('secure.connected','Secure channel connected for this session'):T('secure.notConnected','Secure channel not connected'));
$('sstatus').textContent=open?T('settings.authDisabledNotice','This server does not require an API key.'):state.key?T('settings.keyLoaded','Session API key loaded.'):T('settings.keyNotSet','API key not set.');
$('sstatus').className='status '+(ready?'good':'')}
async function save(){state.key=$('key').value.trim();
state.ws=$('workspace').value.trim()||'default';
sessionStorage.setItem('huqan-api-key',state.key);
sessionStorage.setItem('huqan-workspace',state.ws);
const button=$('save'),label=button.textContent;
button.disabled=true;
button.textContent=T('settings.connecting','Connecting…');
settings();
try{await refresh();
const failed=Object.values(state.surfaces).some(x=>x.s==='err');
const locked=Object.values(state.surfaces).some(x=>x.s==='locked');
$('sstatus').textContent=failed?T('settings.connectionFailed','Connection failed.'):locked?T('settings.surfacesLocked','API key required for one or more surfaces.'):T('settings.connected','Connected.');
$('sstatus').className='status '+(failed?'bad':locked?'':'good')}
finally{button.disabled=false;
button.textContent=label}
}
