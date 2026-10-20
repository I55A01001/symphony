import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJamServer,cleanSnapshot,cleanTrack } from './server.mjs';
const track={id:'dQw4w9WgXcQ',title:'A song',artists:'An artist',durationMs:10000,coverUrl:'https://example.com/cover.png'};
test('validates and sanitizes shared music metadata',()=>{
  assert.throws(()=>cleanTrack({id:'file:///etc/passwd'}));
  assert.equal(cleanTrack({...track,coverUrl:'file:///private'}).coverUrl,'');
  assert.throws(()=>cleanSnapshot({queue:[track],currentIndex:4,status:'playing'}));
  assert.throws(()=>cleanSnapshot({queue:Array(201).fill(track),currentIndex:0,status:'playing'}));
});
test('two clients share a queue and state, with equal participant controls',async()=>{
  const server=createJamServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const controllers=[];
  const post=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  async function stream(room,token){
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(`${base}/rooms/${room}/events?token=${token}`,{signal:controller.signal});
    const reader=response.body.getReader();let buffer='';const decoder=new TextDecoder();
    return async(type)=>{for(;;){let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(block.startsWith(`event: ${type}\n`))return JSON.parse(block.split('\ndata: ')[1]);}const result=await reader.read();if(result.done)throw Error('Stream ended');buffer+=decoder.decode(result.value,{stream:true});}};
  }
  try{
    const landing=await fetch(base+'/');
    assert.equal(landing.status,200);assert.match(await landing.text(),/Join your friends/);
    const host=(await post('/rooms',{name:'Host'})).data;
    const path=`/rooms/${host.roomId}`;
    assert.equal((await post(path+'/join',{name:'Bad',invite:'wrong'})).status,403);
    const guest=(await post(path+'/join',{name:'Guest',invite:host.invite})).data;
    const hostEvent=await stream(host.roomId,host.token);
    const guestEvent=await stream(host.roomId,guest.token);
    assert.equal((await guestEvent('members')).length,2);
    const state={queue:[track],currentIndex:0,status:'playing',positionMs:1234,rate:1,shuffle:true,repeat:'all'};
    assert.equal((await post(path+'/actions',{type:'snapshot',state},guest.token)).status,403);
    assert.equal((await post(path+'/actions',{type:'snapshot',state},host.token)).status,200);
    assert.equal((await guestEvent('snapshot')).positionMs,1234);
    await post(path+'/actions',{type:'enqueue',track},guest.token);
    const addition=await hostEvent('enqueue');
    assert.equal(addition.track.id,track.id);
    const recovered=await fetch(base+path+'/status',{headers:{Authorization:`Bearer ${host.token}`}}).then(r=>r.json());
    assert.equal(recovered.additions[0].id,addition.id);
    assert.equal(recovered.snapshot.positionMs,1234);
    assert.equal(recovered.snapshot.shuffle,true);assert.equal(recovered.snapshot.repeat,'all');
    assert.equal((await post(path+'/actions',{type:'ack',ids:[addition.id]},guest.token)).status,403);
    await post(path+'/actions',{type:'ack',ids:[addition.id]},host.token);
    const acknowledged=await fetch(base+path+'/status',{headers:{Authorization:`Bearer ${host.token}`}}).then(r=>r.json());
    assert.equal(acknowledged.additions.length,0);
    for(const command of ['skip','pause','resume','stop','previous','clear']){
      assert.equal((await post(path+'/actions',{type:'control',command},guest.token)).status,200);
    }
    assert.equal((await post(path+'/actions',{type:'control',command:'seek',payload:{positionMs:5000}},guest.token)).status,200);
    assert.equal((await post(path+'/actions',{type:'control',command:'seek',payload:{positionMs:-1}},guest.token)).status,400);
    for(const [command,payload] of [['remove',{index:0,trackId:track.id}],['shuffle',{enabled:true}],['repeat',{mode:'one'}],['play',{track,queue:[track],queueIndex:0}]]){
      assert.equal((await post(path+'/actions',{type:'control',command,payload},guest.token)).status,200);
    }
    for(const [command,payload] of [['remove',{index:-1,trackId:track.id}],['shuffle',{enabled:'yes'}],['repeat',{mode:'bad'}]]){
      assert.equal((await post(path+'/actions',{type:'control',command,payload},guest.token)).status,400);
    }
    const command=await hostEvent('control');assert.equal(command.command,'skip');
    const pendingControls=await fetch(base+path+'/status',{headers:{Authorization:`Bearer ${host.token}`}}).then(r=>r.json());
    assert.equal(pendingControls.controls[0].id,command.id);
    assert.equal(pendingControls.members.some(m=>'canSkip' in m||'canPause' in m),false);
    await post(path+'/actions',{type:'ack',ids:[command.id]},host.token);
    const other=(await post(path+'/join',{name:'Other',invite:host.invite})).data;
    assert.equal((await post(path+'/actions',{type:'kick',id:other.participantId},guest.token)).status,200);
    assert.equal((await post(path+'/actions',{type:'control',command:'skip'},other.token)).status,403);
    await post(path+'/actions',{type:'kick',id:guest.participantId},host.token);
    await guestEvent('removed');
    assert.equal((await post(path+'/actions',{type:'enqueue',track},guest.token)).status,403);
    const last=(await post(path+'/join',{name:'Last',invite:host.invite})).data;
    assert.equal((await post(path+'/actions',{type:'end'},last.token)).status,200);
    assert.equal((await post(path+'/join',{name:'Late',invite:host.invite})).status,404);
  }finally{controllers.forEach(c=>c.abort());server.closeAllConnections();await new Promise(r=>server.close(r));}
});
