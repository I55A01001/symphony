import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const secret = () => randomBytes(24).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
export function cleanTrack(t) {
  if (!t || typeof t.id !== 'string' || !/^[\w:.-]{1,160}$/.test(t.id) || typeof t.title !== 'string' || typeof t.artists !== 'string') throw fail(400, 'Invalid track');
  const coverUrl = typeof t.coverUrl === 'string' && /^https:\/\//.test(t.coverUrl) ? t.coverUrl.slice(0, 2048) : '';
  return { id:t.id, title:t.title.slice(0,240), artists:t.artists.slice(0,240), coverUrl,
    durationMs: Math.max(0,Math.min(Number(t.durationMs)||0,86_400_000)), playCount:0 };
}
export function cleanSnapshot(s) {
  if (!s || !Array.isArray(s.queue) || s.queue.length > 200 || !['playing','paused','loading','idle','error'].includes(s.status)) throw fail(400,'Invalid playback state');
  const queue=s.queue.map(cleanTrack);
  const index=Number.isInteger(s.currentIndex) ? s.currentIndex : -1;
  if (index < -1 || index >= queue.length) throw fail(400,'Invalid queue index');
  return { queue, currentIndex:index, status:s.status, positionMs:Math.max(0,Math.min(Number(s.positionMs)||0,86_400_000)), rate:Math.max(.25,Math.min(Number(s.rate)||1,4)), at:Date.now() };
}
export function createJamServer() {
  const rooms=new Map(), budgets=new Map();
  const send=(res,type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast=(room,type,data)=>{ for(const p of room.people.values()) if(p.stream) send(p.stream,type,data); };
  const members=room=>[...room.people.values()].map(p=>({id:p.id,name:p.name,host:p.host,online:!!p.stream||Date.now()-p.lastSeen<6000}));
  const end=room=>{broadcast(room,'ended',{}); for(const p of room.people.values()) p.stream?.end(); rooms.delete(room.id);};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Cache-Control','no-store');
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET' && url.pathname==='/health'){json(200,{ok:true,now:Date.now()});return;}
      const address=req.socket.remoteAddress;
      const now=Date.now(); const budget=budgets.get(address)||{at:now,n:0};
      if(now-budget.at>60_000){budget.at=now;budget.n=0;} budgets.set(address,budget);
      if(++budget.n>1200) throw fail(429,'Too many requests. Try again shortly.');
      const body=async()=>{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>256_000) throw fail(413,'Request too large');}try{return JSON.parse(raw||'{}');}catch{throw fail(400,'Invalid JSON');}};
      const person=(name,host)=>({id:secret(),token:secret(),name:String(name||'Listener').trim().slice(0,32)||'Listener',host,stream:null,lastSeen:now});
      const credentials=(room,p)=>({roomId:room.id,invite:room.invite,token:p.token,participantId:p.id,host:p.host});
      if(req.method==='POST' && url.pathname==='/rooms'){
        if(rooms.size>=500) throw fail(503,'Jam server is full');
        const b=await body(), p=person(b.name,true);
        const room={id:randomBytes(6).toString('hex'),invite:secret(),people:new Map([[p.token,p]]),state:null,pending:new Map(),updated:now,hostLostAt:null};
        rooms.set(room.id,room);json(201,credentials(room,p));return;
      }
      const match=/^\/rooms\/([a-f0-9]{12})\/(join|events|actions|status)$/.exec(url.pathname);
      if(!match) throw fail(404,'Not found');
      const room=rooms.get(match[1]); if(!room) throw fail(404,'This Jam has ended or does not exist');
      if(match[2]==='join' && req.method==='POST'){
        const b=await body(); if(b.invite!==room.invite) throw fail(403,'Invalid invite code');
        if(room.people.size>=20) throw fail(409,'This Jam is full (20 listeners)');
        const p=person(b.name,false);room.people.set(p.token,p);room.updated=now;
        broadcast(room,'members',members(room));json(200,credentials(room,p));return;
      }
      const token=req.headers.authorization?.replace(/^Bearer /,'') || url.searchParams.get('token');
      const p=room.people.get(token);if(!p) throw fail(403,'Session expired. Join again.');
      p.lastSeen=now;room.updated=now;
      if(match[2]==='status' && req.method==='GET'){
        if(p.host)room.hostLostAt=null;
        json(200,{ok:true,members:members(room),snapshot:room.state,additions:p.host?[...room.pending.values()]:[],now:Date.now()});return;
      }
      if(match[2]==='events' && req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
        p.stream?.end();p.stream=res;if(p.host) room.hostLostAt=null;
        send(res,'members',members(room));if(room.state) send(res,'snapshot',room.state);
        broadcast(room,'members',members(room));
        req.on('close',()=>{if(p.stream!==res)return;p.stream=null;p.lastSeen=Date.now();if(p.host)room.hostLostAt=Date.now();broadcast(room,'members',members(room));});
        return;
      }
      if(match[2]!=='actions' || req.method!=='POST') throw fail(405,'Method not allowed');
      const b=await body();
      if(b.type==='snapshot'){
        if(!p.host) throw fail(403,'Only the host can control playback');
        room.state=cleanSnapshot(b.state);broadcast(room,'snapshot',room.state);
      } else if(b.type==='enqueue') {
        if(![...room.people.values()].some(x=>x.host&&(x.stream||now-x.lastSeen<6000))) throw fail(409,'The host is reconnecting. Try again shortly.');
        if((room.state?.queue.length||0)+room.pending.size>=200) throw fail(409,'The shared queue is full (200 songs)');
        const track=cleanTrack(b.track);const addition={id:secret(),track,by:p.name};
        room.pending.set(addition.id,addition);broadcast(room,'enqueue',addition);
      } else if(b.type==='ack') {
        if(!p.host) throw fail(403,'Only the host can acknowledge queue additions');
        if(!Array.isArray(b.ids)||b.ids.length>200)throw fail(400,'Invalid acknowledgement');
        for(const id of b.ids)room.pending.delete(id);
      } else if(b.type==='kick') {
        if(!p.host) throw fail(403,'Only the host can remove listeners');
        const target=[...room.people.values()].find(x=>x.id===b.id&&!x.host);
        if(target){if(target.stream){send(target.stream,'removed',{});target.stream.end();}room.people.delete(target.token);broadcast(room,'members',members(room));}
      } else if(b.type==='leave') {
        if(p.host) end(room);else{p.stream?.end();room.people.delete(p.token);broadcast(room,'members',members(room));}
      } else throw fail(400,'Unknown action');
      json(200,{ok:true});
    }catch(e){if(!res.headersSent)json(e.status||500,{error:e.status?e.message:'Server error'});else res.end();}
  });
  const timer=setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values()){
      if(now-room.updated>30*60_000 || (room.hostLostAt && now-room.hostLostAt>30_000)){end(room);continue;}
      for(const [token,p] of room.people){
        if(p.stream)p.stream.write(': heartbeat\n\n');
        else if(!p.host && now-p.lastSeen>60_000){room.people.delete(token);broadcast(room,'members',members(room));}
      }
    }
    for(const [ip,b] of budgets) if(now-b.at>120_000) budgets.delete(ip);
  },10_000);timer.unref();server.on('close',()=>clearInterval(timer));
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createJamServer();server.listen(Number(process.env.PORT)||8787,'0.0.0.0',()=>console.log('Symphony Jam relay listening'));
}
