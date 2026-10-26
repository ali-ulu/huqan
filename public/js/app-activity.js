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
function pulseStatus(kind,detail=''){const e=$('activitypulsestate'),tone=kind==='LIVE'?'ok':kind==='LOCKED'?'locked':kind==='ERROR'?'err':kind==='OFFLINE'?'err':kind==='DEGRADED'?'warn':'';e.textContent=kind;
e.className='state '+tone;
$('activitypulsemeta').textContent=detail||`workspace scoped · ${state.ws}`}
function pulseTime(value){const parsed=Date.parse(value||'');
return Number.isFinite(parsed)?new Intl.DateTimeFormat(locale(),{hour:'2-digit',minute:'2-digit'}).format(new Date(parsed)):String(value||'—')}
function pulseDecision(item){if(item?.receipt?.browserSession)return{text:T('activity.observed','OBSERVED'),tone:''}
;
const decision=String(item?.receipt?.decision||'').toLowerCase();
return{text:decision?decision.toUpperCase():'—',tone:/allow|approved|accept/.test(decision)?'good':/reject|deny|block/.test(decision)?'bad':''}
};
var __huqanSSEStatus = null;
function renderAgentActivityPulse(kind='LIVE',detail=''){const p=state.activityPulse||{items:[],hasMore:false}
 ,status=String(kind).toUpperCase(),list=$('activitypulseitems');
// Retain SSE stream status if present (overrides EMPTY/LIVE, LOCKED is authoritative)
if (__huqanSSEStatus && (__huqanSSEStatus.status === 'OFFLINE' || __huqanSSEStatus.status === 'DEGRADED')) {
  status = __huqanSSEStatus.status;
  detail = __huqanSSEStatus.detail || detail;
  const tone = status === 'OFFLINE'?'err':status === 'DEGRADED'?'warn':'';
  $('activitypulsestate').textContent=status;
  $('activitypulsestate').className='state '+tone;
  $('activitypulsemeta').textContent=detail||`workspace scoped · ${state.ws}`;
  $('activitypulsecount').textContent='—';
  $('activitypulseactors').textContent='—';
  $('activitypulsereceipts').textContent='—';
  const toneName = status === 'OFFLINE' ? 'offline' : 'degraded';
  list.innerHTML=`<div class="empty">${esc(T('pulse.' + toneName, toneName === 'offline' ? 'offline.body' : 'degraded.body'))}</div>`;
  return}
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
if(status==='EMPTY'){// Only show EMPTY if no SSE status overriding
if(!(__huqanSSEStatus && (__huqanSSEStatus.status === 'OFFLINE' || __huqanSSEStatus.status === 'DEGRADED'))){['activitypulsecount','activitypulseactors','activitypulsereceipts'].forEach(id=>$(id).textContent='—');
pulseStatus('EMPTY',`${state.ws} · No activity on this page`);
list.innerHTML=`<div class="empty">${esc(T('pulse.empty','No agent actions in this workspace yet.'))}</div>;
}}
const items=Array.isArray(p.items)?p.items.slice(0,5):[],actors=new Set(items.map(x=>x.actor||'system')),receipts=items.filter(x=>x.receipt?.receiptId).length;
$('activitypulsecount').textContent=String(items.length);
$('activitypulseactors').textContent=String(items.length?actors.size:0);
$('activitypulsereceipts').textContent=String(receipts);
if(!items.length){
  const msg = `${state.ws} · No activity on this page`;
  pulseStatus('EMPTY', msg);
  list.innerHTML=`<div class="empty">${esc(T('pulse.empty','No agent actions in this workspace yet.'))}</div>`;
  return;
}