'use strict';
// HUQAN dashboard net: auth headers, fetch, clock, view switch.
// Split out of the former public/js/app.js bundle, which had been collapsed onto
// one statement per line. Load order is fixed by public/index.html and the
// scripts share one top-level scope, exactly as before the split.
const headers=json=>({...json?{'Content-Type':'application/json'}:{},...state.key?{Authorization:`Bearer ${state.key}`}:{}});
const endId=v=>v&&typeof v==='object'?(v.id||v.name||''):String(v||'');
async function json(url,opt={}){const r=await fetch(url,opt),d=await r.json().catch(()=>({}));
return{r,d}
}
function clock(){ $('clock').textContent=new Intl.DateTimeFormat(locale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())}
setInterval(clock,1000);
clock();
function go(v){document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.v===v));
document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===`v-${v}`));
if(v==='approvals')loadApprovals();
if(v==='activity')loadActivity(true);
if(v==='graph'||v==='conflicts')loadGraph();
if(v==='integrations')renderSurfaces()}
