'use strict';
// HUQAN dashboard activity: pulse, activity list, receipts.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
function activityStatus(t,bad=false,good=false){$('activitystatus').textContent=t;
$('activitystatus').className='status '+(bad?'bad':good?'good':'')}
function renderActivityDetail(x){if(!x){$('activitydetailstatus').textContent=T('activity.noRow','No row selected');
$('activitysummary').innerHTML=`<dt>${esc(T('evidence.rows.status','Status'))}</dt><dd>—</dd>`;
$('activityjson').textContent=T('activity.selectRow','Select an activity row.');
return}
const rows=[[T('activity.rows.event','Event'),x.eventType||'—'],[T('activity.rows.action','Action'),x.action||'—'],[T('activity.rows.actor','Actor'),x.actor||'—'],[T('activity.rows.target','Target'),`${x.targetType||'—'}:${x.targetId||'—'}`],[T('activity.rows.timestamp','Timestamp'),x.timestamp||'—'],[T('activity.rows.source','Source'),x.sourceRef||'—'],[T('activity.rows.provenance','Provenance'),x.provenanceId||'—'],[T('activity.rows.receipt','Receipt'),x.receipt?.receiptId||T('activity.auditOnly','audit only')],[T('activity.rows.decision','Decision'),x.receipt?.browserSession?T('activity.observationOnly','observation-only'):(x.receipt?.decision||'—')]];
if(x.receipt?.destination?.url)rows.push([T('activity.rows.destination','Page'),x.receipt.destination.url]);
if(x.receipt?.toolName)rows.push([T('activity.rows.browserTool','Browser operation'),x.receipt.toolName]);
if(x.receipt?.reportedOutcomeStatus)rows.push([T('activity.rows.reportedOutcome','Reported outcome'),x.receipt.reportedOutcomeStatus]);
const bs=x.receipt?.browserSession;
if(bs){if(bs.sessionId)rows.push([T('activity.rows.browserSession','Browser session'),bs.sessionId]);
if(bs.event)rows.push([T('activity.rows.browserEvent','Browser event'),bs.event+(bs.phase?` · `+bs.phase:'')]);
if(bs.destination?.url)rows.push([T('activity.rows.destination','Page'),bs.destination.url]);
if(bs.method)rows.push([T('activity.rows.networkMethod','Network method'),bs.method]);
if(bs.statusCode!==null&&bs.statusCode!==undefined)rows.push([T('activity.rows.networkStatus','Network status'),String(bs.statusCode)]);
if(bs.consoleType)rows.push([T('activity.rows.consoleType','Console type'),bs.consoleType]);
if(bs.outcomeReceiptId)rows.push([T('activity.rows.boundOutcome','Bound outcome'),(bs.outcomeBinding?bs.outcomeBinding+' · ':'')+bs.outcomeReceiptId]);
}
$('activitydetailstatus').textContent=x.receipt?T('activity.receiptLinked','receipt linked'):T('activity.auditOnly','audit only');
$('activitysummary').innerHTML=rows.map(([a,b])=>`<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('');
$('activityjson').textContent=JSON.stringify(x,null,2)}
function renderActivity(){const items=state.activity.items||[];
$('activitycount').textContent=items.length;
$('activitymeta').textContent=`${items.length} row · ${state.activity.hasMore?'next page available':'bounded page'}`;
$('activitynext').disabled=!state.activity.hasMore;
$('activitylist').innerHTML=items.map(x=>`<div class="item activityrow" data-activity-id="${esc(x.auditId)}" tabindex="0"><b>${esc(x.eventType||'AUDIT')} · ${esc(x.action||'activity')}</b><div class="sub">${esc(x.timestamp||'—')} · ${esc(x.actor||'system')} · ${esc(x.targetType||'—')}:${esc(x.targetId||'—')}</div><span class="tag">${esc(x.sourceRef||'audit')}</span>${x.receipt?`<span class="tag good">Receipt ${esc(x.receipt.receiptId)}</span><div class="actions activityreceipt"><button class="btn" data-activity-receipt="${esc(x.receipt.receiptId)}">${esc(T('evidence.openReceipt','Open receipt'))}</button></div>`:''}</div>`).join('')||`<div class="empty">${esc(T('activity.noneForFilters','No activity found for these filters.'))}</div>`}
function pulseStatus(kind,detail=''){const e=$('activitypulsestate'),tone=kind==='LIVE'?'ok':kind==='LOCKED'?'locked':kind==='ERROR'?'err':'';
e.textContent=kind;
e.className='state '+tone;
$('activitypulsemeta').textContent=detail||`workspace scoped · ${state.ws}`}
function pulseTime(value){const parsed=Date.parse(value||'');
return Number.isFinite(parsed)?new Intl.DateTimeFormat(locale(),{hour:'2-digit',minute:'2-digit'}).format(new Date(parsed)):String(value||'—')}
function pulseDecision(item){if(item?.receipt?.browserSession)return{text:T('activity.observed','OBSERVED'),tone:''}
;
const decision=String(item?.receipt?.decision||'').toLowerCase();
return{text:decision?decision.toUpperCase():'—',tone:/allow|approved|accept/.test(decision)?'good':/reject|deny|block/.test(decision)?'bad':''}
}
function renderAgentActivityPulse(kind='LIVE',detail=''){const p=state.activityPulse||{items:[],hasMore:false}
,status=String(kind).toUpperCase(),list=$('activitypulseitems');
if(status==='LOADING'){['activitypulsecount','activitypulseactors','activitypulsereceipts'].forEach(id=>$(id).textContent='—');
pulseStatus('LOADING',`${state.ws} · Loading activity…`);
list.innerHTML=`<div class="empty">${esc(T('activity.loading','Loading activity…'))}</div>`;
return}
if(status==='LOCKED'){['activitypulsecount','activitypulseactors','activitypulsereceipts'].forEach(id=>$(id).textContent='—');
pulseStatus('LOCKED',`${state.ws} · API key required`);
list.innerHTML=`<div class="empty">${esc(T('pulse.locked','Activity access is locked. Add an API key in Settings.'))}</div>`;
return}
if(status==='ERROR'){['activitypulsecount','activitypulseactors','activitypulsereceipts'].forEach(id=>$(id).textContent='—');
pulseStatus('ERROR',`${state.ws} · ${detail||'read failed'}`);
list.innerHTML=`<div class="empty">${esc(T('pulse.error','Activity could not be loaded. Try again.'))}</div>`;
return}
const items=Array.isArray(p.items)?p.items.slice(0,5):[],actors=new Set(items.map(x=>x.actor||'system')),receipts=items.filter(x=>x.receipt?.receiptId).length;
$('activitypulsecount').textContent=String(items.length);
$('activitypulseactors').textContent=String(items.length?actors.size:0);
$('activitypulsereceipts').textContent=String(receipts);
if(!items.length){pulseStatus('EMPTY',`${state.ws} · No activity on this page`);
list.innerHTML=`<div class="empty">${esc(T('pulse.empty','No agent actions in this workspace yet.'))}</div>`;
return}
pulseStatus('LIVE',`${state.ws} · ${items.length} page events${p.hasMore?' · more available':''}${detail?` · ${detail}`:''}`);
list.innerHTML=items.map(x=>{const decision=pulseDecision(x),target=x.targetId?`${x.targetType||'target'}:${x.targetId}`:'—',label=`${x.eventType||'AUDIT'} ${x.action||'activity'} by ${x.actor||'system'}`;return `<div class="pulserow" data-activity-pulse-id="${esc(x.auditId)}" role="button" tabindex="0" aria-label="${esc(label)}"><i class="pulse-dot ${decision.tone}" aria-hidden="true"></i><div><b>${esc(x.eventType||'AUDIT')} · ${esc(x.action||'activity')}</b><span>${esc(x.actor||'system')} · ${esc(x.tool||target)} · ${esc(pulseTime(x.timestamp))}</span></div><span class="tag ${decision.tone}" title="${esc(x.receipt?.receiptId||T('evidence.noReceipt','No receipt'))}">${esc(decision.text)}</span></div>`}).join('')}
async function loadActivityPulse(){surface('activity','checking',{reason:M('runtime.loading.activity','Loading activity.'),nextAction:M('runtime.next.wait','Wait')});
renderAgentActivityPulse('LOADING');
try{const q=new URLSearchParams({workspaceId:state.ws,limit:'5',order:'desc'}),{r,d}
=await json(`/api/workbench/activity?${q}`,{headers:headers()});
if(!r.ok){const locked=r.status===401||r.status===403;
surface('activity',locked?'locked':'err',{reason:locked?M('runtime.locked.activity','API key required to read activity.'):{k:'runtime.failed.activityHttp',f:`Activity request failed with HTTP ${r.status}.`,p:{status:r.status}},nextAction:locked?M('onboarding.steps.session.cta','Open Settings'):M('common.retry','Retry')});
renderAgentActivityPulse(r.status===401||r.status===403?'LOCKED':'ERROR',d?.error?.code||`HTTP ${r.status}`);
return}
if(!d.ok||!Array.isArray(d.items))throw Error(d?.error?.code||'ACTIVITY_INVALID_RESPONSE');
state.activityPulse={items:d.items.slice(0,5),nextCursor:d.nextCursor||null,hasMore:Boolean(d.hasMore),lastChecked:Date.now()}
;
const empty=!state.activityPulse.items.length;
surface('activity',empty?'empty':'ok',{reason:empty?M('runtime.empty.activity','No activity exists in this workspace.'):M('runtime.fetched.activity','Activity fetched for this workspace.'),nextAction:M('common.refresh','Refresh')});
renderAgentActivityPulse(empty?'EMPTY':'LIVE')}
catch(e){surface('activity','err',{reason:{k:'runtime.failed.activityDetail',f:`Activity request failed: ${e.message}`,p:{message:e.message}},nextAction:M('common.retry','Retry')});
state.activityPulse={items:[],nextCursor:null,hasMore:false,lastChecked:null}
;
renderAgentActivityPulse('ERROR',e.message)}
}
async function loadActivity(reset=true){activityStatus(T('activity.loading','Loading activity…'));
try{const q=new URLSearchParams({workspaceId:state.ws,limit:'25'}),actor=$('activityactor').value.trim(),eventType=$('activityevent').value;
if(actor)q.set('actor',actor);
if(eventType)q.set('eventType',eventType);
if(!reset&&state.activity.nextCursor)q.set('cursor',state.activity.nextCursor);
const{r,d}
=await json(`/api/workbench/activity?${q}`,{headers:headers()});
if(!r.ok||!d.ok)throw Error(d?.error?.code||`HTTP ${r.status}`);
state.activity.items=reset?d.items:[...state.activity.items,...d.items];
state.activity.nextCursor=d.nextCursor;
state.activity.hasMore=Boolean(d.hasMore);
renderActivity();
activityStatus(T('activity.updated','Activity updated.'),0,true)}
catch(e){state.activity.items=[];
state.activity.nextCursor=null;
state.activity.hasMore=false;
renderActivity();
activityStatus(`activity failed: ${e.message}`,1)}
}
function openAgentActivity(id){const pulse=state.activityPulse||{items:[],hasMore:false}
;
state.activity.items=Array.isArray(pulse.items)?pulse.items.slice():[];
state.activity.nextCursor=null;
state.activity.hasMore=Boolean(pulse.hasMore);
renderActivity();
go('activity');
if(id)showActivity(id)}
function showActivity(id){renderActivityDetail(state.activity.items.find(x=>x.auditId===id)||null)}
function openActivityReceipt(id){if(!id)return;
$('einput').value=id;
$('emode').value='receiptId';
go('evidence');
loadReceipt()}
function receipt(id,label,status){state.recent=[{id:String(id),label:String(label||T('evidence.defaultLabel','Trust Receipt')),status:String(status||'')},...state.recent.filter(x=>x.id!==String(id))].slice(0,5);
renderRecent()}
function renderRecent(){$('recent').innerHTML=state.recent.map(x=>`<div class="receipt" data-receipt="${esc(x.id)}" role="button" tabindex="0" title="${esc(T('evidence.openReceipt','Open receipt'))}"><div><b>${esc(x.id)}</b><span>${esc(Tx(x.label))}</span></div><em>${esc(x.status||'—')}</em></div>`).join('')||`<div class="empty">${esc(T('rail.noReceipts','No receipts yet.'))}</div>`}
function openReceipt(n){if(!n)return;
$('einput').value=n.dataset.receipt;
$('emode').value='receiptId';
go('evidence');
loadReceipt()}
