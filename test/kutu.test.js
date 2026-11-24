const {test}=require('node:test');
const assert=require('node:assert/strict');
const catan=require('../public/catan-kurallar');
const munchkin=require('../public/munchkin-kurallar');
const {startServer,client,ack,next}=require('./helpers');

test('Catan · ada, yılan sıralı kurulum, mesafe ve karşılıklı takas',()=>{
  const g=catan.create(['Ada','Deniz','Kum']);
  assert.deepEqual([g.tiles.length,g.nodes.length,g.edges.length],[19,54,72]);
  for(const p of [0,1,2,2,1,0]) {
    assert.equal(g.turn,p);
    catan.play(g,catan.available(g)[0]);
    catan.play(g,catan.available(g)[0]);
  }
  assert.equal(g.phase,'roll');
  assert.deepEqual(g.players.map((_,p)=>catan.score(g,p)),[2,2,2]);
  for(const e of g.edges) assert.ok(!(g.nodes[e.a].level && g.nodes[e.b].level));
  g.phase='build'; g.hand[0]=[4,0,0,0,0]; g.hand[1]=[0,1,0,0,0];
  const offer='offer:1:0:1';
  assert.ok(catan.available(g).includes(offer));
  catan.play(g,offer); catan.play(g,'decline'); assert.equal(g.hand[0][0],4);
  catan.play(g,offer); catan.play(g,'accept');
  assert.deepEqual(g.hand[0],[3,1,0,0,0]); assert.deepEqual(g.hand[1],[1,0,0,0,0]); assert.equal(g.turn,0);
});
test('Munchkin · yardım kararı, iksir ve onuncu seviyede zafer',()=>{
  const g=munchkin.create(['Ay','Gün']);
  Object.assign(g,{phase:'combat',monster:{name:'Dev',strength:12},asked:[],helper:null});
  g.heroes[0].level=9;
  munchkin.play(g,'help:1');
  assert.deepEqual(munchkin.available(g),['accept','decline']);
  munchkin.play(g,'accept'); assert.equal(g.turn,0);
  munchkin.play(g,'potion'); assert.equal(g.heroes[0].potions,0);
  munchkin.play(g,'fight'); assert.ok(g.done); assert.equal(g.heroes[0].level,10);
  assert.ok(g.heroes[1].gear.some(id=>id>=0));
});
test('Kutu oyunları · gerçek oda lobisi, oyuncu yetkisi ve sunucu hamlesi',async t=>{
  const srv=await startServer(), clients=[];
  t.after(async()=>{for(const s of clients)s.close();await srv.stop();});
  for(const n of ['Ada','Deniz']){
    const s=await client(srv.url,n);clients.push(s);
    await ack(s,'join',{token:s.token,clientId:n});
  }
  const [a,b]=clients;
  for(const key of ['catan','munchkin']){
    let ready=next(a,'lobbies'); a.emit('lobby:open',{game:key}); await ready;
    ready=next(a,'lobbies'); b.emit('lobby:join',{game:key}); await ready;
    ready=next(a,'kutu:state'); a.emit('lobby:start',{game:key});
    const {game}=await ready;
    const engine=key==='catan'?catan:munchkin;
    const packet={key,id:game.id,revision:0,action:engine.available(game)[0]};
    b.emit('kutu:action',packet); await ack(b,'hello',{token:b.token});
    ready=next(a,'kutu:state'); a.emit('kutu:action',packet);
    assert.equal((await ready).game.revision,1);
  }
});
