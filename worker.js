const J=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const eq=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
export default{async fetch(req,env){
 const url=new URL(req.url),p=url.pathname;
 if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
 const db=env.DB;
 // The whole site is staff-only: every API call needs COACH_PASS or STAFF_PASS.
 const pass=req.headers.get('x-pass')||'';
 const role=(env.COACH_PASS&&eq(pass,env.COACH_PASS))?'coach':(env.STAFF_PASS&&eq(pass,env.STAFF_PASS))?'staff':'';
 if(!role)return J({error:'auth'},401);
 if(p==='/api/auth')return J({ok:1,role});
 // Staff-only: coach or staff can read the season.
 if(req.method==='GET'&&p==='/api/season'){
  const since=+url.searchParams.get('since')||0;
  const g=await db.prepare('SELECT json FROM games WHERE u>? ORDER BY id').bind(since).all();
  const r=await db.prepare("SELECT json,u FROM meta WHERE k='roster'").first();
  const dl=await db.prepare("SELECT k FROM meta WHERE k LIKE 'del:%'").all();
  return J({games:g.results.map(x=>JSON.parse(x.json)),roster:r&&r.u>since?JSON.parse(r.json):null,ru:r?r.u:0,deleted:dl.results.map(x=>x.k.slice(4))});
 }
 // Scouting reports: coach and staff can read and write; only the coach can delete. Never public.
 const sv="INSERT INTO meta(k,json,u) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET json=excluded.json,u=excluded.u";
 if(p==='/api/scouts'&&req.method==='GET'){
  const r=await db.prepare("SELECT json FROM meta WHERE k LIKE 'scout:%'").all(),o=await db.prepare("SELECT k,json FROM meta WHERE k LIKE 'opp:%'").all();
  return J({reports:r.results.map(x=>JSON.parse(x.json)),opp:o.results.map(x=>({key:x.k.slice(4),data:JSON.parse(x.json)}))});
 }
 const sm=p.match(/^\/api\/scout\/(\d+)$/);
 if(sm&&req.method==='PUT'){
  const t=await req.text();if(t.length>400000)return J({error:'too big'},413);
  let g;try{g=JSON.parse(t)}catch(e){return J({error:'bad json'},400)}
  if(String(g.id)!==sm[1])return J({error:'id mismatch'},400);
  await db.prepare(sv).bind('scout:'+sm[1],t,Date.now()).run();return J({ok:1});
 }
 const om=p.match(/^\/api\/opp\/([a-z0-9-]{1,80})$/);
 if(om&&req.method==='PUT'){
  const t=await req.text();if(t.length>200000)return J({error:'too big'},413);
  try{JSON.parse(t)}catch(e){return J({error:'bad json'},400)}
  await db.prepare(sv).bind('opp:'+om[1],t,Date.now()).run();return J({ok:1});
 }
 if(om&&req.method==='DELETE'&&role==='coach'){await db.prepare('DELETE FROM meta WHERE k=?').bind('opp:'+om[1]).run();return J({ok:1})}
 if(sm&&req.method==='DELETE'&&role==='coach'){await db.prepare('DELETE FROM meta WHERE k=?').bind('scout:'+sm[1]).run();return J({ok:1})}
 // Everything below is coach only.
 if(role!=='coach')return J({error:'forbidden'},403);
 const m=p.match(/^\/api\/game\/(\d+)$/);
 if(m&&req.method==='PUT'){
  const t=await req.text();if(t.length>1500000)return J({error:'too big'},413);
  let g;try{g=JSON.parse(t)}catch(e){return J({error:'bad json'},400)}
  if(String(g.id)!==m[1])return J({error:'id mismatch'},400);
  // A game that was deleted stays deleted, even if an out-of-date device tries to save it again.
  if(await db.prepare('SELECT 1 FROM meta WHERE k=?').bind('del:'+m[1]).first())return J({ok:1,deleted:1});
  await db.prepare('INSERT INTO games(id,json,u) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,u=excluded.u').bind(m[1],t,g.u||Date.now()).run();
  return J({ok:1});
 }
 if(m&&req.method==='DELETE'){
  let b={};try{b=await req.json()}catch(e){}
  const row=await db.prepare('SELECT json FROM games WHERE id=?').bind(m[1]).first(),gj=b&&b.game?JSON.stringify(b.game):(row?row.json:null);
  if(gj)await db.prepare("INSERT INTO meta(k,json,u) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET json=excluded.json,u=excluded.u").bind('trash:'+m[1],gj,Date.now()).run();
  await db.prepare("DELETE FROM meta WHERE k LIKE 'trash:%' AND u<?").bind(Date.now()-30*864e5).run();
  await db.prepare('DELETE FROM games WHERE id=?').bind(m[1]).run();await db.prepare("INSERT INTO meta(k,json,u) VALUES(?,'1',?) ON CONFLICT(k) DO UPDATE SET u=excluded.u").bind('del:'+m[1],Date.now()).run();return J({ok:1})}
 // Recently deleted games (coach only): list, restore, or delete for good.
 if(p==='/api/trash'&&req.method==='GET'){
  await db.prepare("DELETE FROM meta WHERE k LIKE 'trash:%' AND u<?").bind(Date.now()-30*864e5).run();
  const t=await db.prepare("SELECT k,json,u FROM meta WHERE k LIKE 'trash:%' ORDER BY u DESC").all();
  return J({trash:t.results.map(x=>({id:x.k.slice(6),at:x.u,game:JSON.parse(x.json)}))});
 }
 const rm=p.match(/^\/api\/(restore|purge)\/(\d+)$/);
 if(rm&&req.method==='POST'){
  const id=rm[2],row=await db.prepare('SELECT json FROM meta WHERE k=?').bind('trash:'+id).first();
  if(!row)return J({error:'not found'},404);
  if(rm[1]==='restore'){
   const g=JSON.parse(row.json);g.u=Date.now();
   await db.prepare('INSERT INTO games(id,json,u) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,u=excluded.u').bind(id,JSON.stringify(g),g.u).run();
   await db.prepare('DELETE FROM meta WHERE k=?').bind('del:'+id).run();
   await db.prepare('DELETE FROM meta WHERE k=?').bind('trash:'+id).run();
   return J({game:g});
  }
  await db.prepare('DELETE FROM meta WHERE k=?').bind('trash:'+id).run();
  return J({ok:1});
 }
 if(p==='/api/roster'&&req.method==='PUT'){
  const b=await req.json();if(!Array.isArray(b.roster))return J({error:'bad roster'},400);
  await db.prepare("INSERT INTO meta(k,json,u) VALUES('roster',?,?) ON CONFLICT(k) DO UPDATE SET json=excluded.json,u=excluded.u").bind(JSON.stringify(b.roster),b.ru||Date.now()).run();
  return J({ok:1});
 }
 return J({error:'not found'},404);
}};
