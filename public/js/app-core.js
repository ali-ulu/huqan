'use strict';
// HUQAN dashboard core: shared helpers, state, lookup.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Runtime copy resolves through the catalogue, with the English string kept
// inline as the fallback. i18n.js loads its catalogue asynchronously and is
// absent entirely when app.js is executed in a test VM, so a lookup that
// cannot be answered must render real English rather than a raw key.
const T=(key,fallback,params)=>{const api=typeof window!=='undefined'&&window.HUQAN_I18N;
const value=api&&api.tSafe?api.tSafe(key,params||{}):null;
return value==null?fallback:value}
;

// A stored message keeps its key next to its English text so state written
// before a locale switch still re-renders in the language chosen after it.
const M=(key,fallback)=>({k:key,f:fallback}),Tx=v=>v&&typeof v==='object'&&v.k?T(v.k,v.f,v.p):v;

// The other page scripts are loaded — and unit-tested — on their own, so they
// reach the lookup through this handle instead of a bare global they cannot
// rely on existing.
if(typeof window!=='undefined')window.HUQAN_T=T;

const locale=()=>{const api=typeof window!=='undefined'&&window.HUQAN_I18N;
return api&&api.getCurrentLocale?api.getCurrentLocale():'en'}
;

const state={key:sessionStorage.getItem('huqan-api-key')||'',ws:sessionStorage.getItem('huqan-workspace')||'default',authRequired:true,manifest:null,graph:{nodes:[],links:[]}
,approvals:[],recent:[],lastPrompt:'',conflicts:{filters:{severity:'',type:''}
,limit:10,findings:[],counts:{high:0,medium:0,low:0,total:0}
}
,activity:{items:[],nextCursor:null,hasMore:false}
,activityPulse:{items:[],nextCursor:null,hasMore:false,lastChecked:null}
,surfaces:{status:{label:M('surfaces.status.label','Runtime Status'),endpoint:'/v2-status',s:'checking',reason:M('surfaces.status.reason','Waiting for runtime status.'),lastChecked:null,nextAction:M('surfaces.status.nextAction','Refresh')}
,workflows:{label:M('surfaces.workflows.label','Workflow Contract'),endpoint:'/api/v2/workflows',s:'checking',reason:M('surfaces.workflows.reason','Waiting for capability manifest.'),lastChecked:null,nextAction:M('surfaces.workflows.nextAction','Refresh')}
,graph:{label:M('surfaces.graph.label','Graph Data'),endpoint:'/graph-data',s:'checking',reason:M('surfaces.graph.reason','Waiting for graph data.'),lastChecked:null,nextAction:M('surfaces.graph.nextAction','Refresh')}
,approvals:{label:M('surfaces.approvals.label','Approval Queue'),endpoint:'/api/v2/approvals',s:'checking',reason:M('surfaces.approvals.reason','Waiting for approval queue.'),lastChecked:null,nextAction:M('surfaces.approvals.nextAction','Refresh')}
,activity:{label:M('surfaces.activity.label','Agent Activity'),endpoint:'/api/workbench/activity',s:'checking',reason:M('surfaces.activity.reason','Waiting for activity.'),lastChecked:null,nextAction:M('surfaces.activity.nextAction','Refresh')}
}
}
;
