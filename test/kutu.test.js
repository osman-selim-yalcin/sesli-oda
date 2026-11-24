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
  assert.equal(g.heroes[1].items.length,3);
  assert.deepEqual(g.heroes[1].gear,[-1,-1,-1]);
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

test('Envanter · kuşanma, gizlilik ve aynı yuvadaki eşyanın değiştirilmesi', () => {
  const g = munchkin.create(['Ay','Gün']);
  const hero = g.heroes[0];
  hero.items.push({type:1, shown:false});
  assert.equal(munchkin.manage(g,0,'equip:0'),true);
  assert.equal(munchkin.power(hero),2);
  assert.deepEqual(munchkin.view(g,'Gün').heroes[0].items,[]);
  assert.equal(munchkin.manage(g,0,'show:0'),true);
  assert.equal(munchkin.view(g,'Gün').heroes[0].gear[0],0);
  assert.equal(munchkin.manage(g,0,'equip:2'),true);
  assert.equal(munchkin.power(hero),4);
  assert.equal(munchkin.view(g,'Gün').heroes[0].gear[0],-1);
  assert.equal(munchkin.manage(g,0,'exchange:0'),true);
  assert.equal(hero.gear[0],1);
  assert.equal(munchkin.power(hero),4);
  assert.equal(hero.potions,2);
  assert.equal(munchkin.manage(g,0,'remove:1'),true);
  assert.equal(munchkin.power(hero),1);
  g.phase='combat';
  assert.equal(munchkin.manage(g,0,'equip:1'),false);
  assert.equal(munchkin.manage(g,1,'show:1'),true);
  assert.equal(munchkin.manage(g,1,'hide:1'),true);
});

test('Envanter · odaya gönderim ve sonradan girişte yalnız gösterilen eşyalar gider', async t => {
  const srv=await startServer(), sockets=[];
  t.after(async()=>{for (const s of sockets) s.close(); await srv.stop();});
  async function join(name) {
    const s=await client(srv.url,name);
    sockets.push(s);
    const info=await ack(s,'join',{token:s.token,clientId:name});
    return {s,info};
  }
  const {s:a}=await join('Ada'), {s:b}=await join('Deniz');
  const key='munchkin';
  let ready=next(a,'lobbies'); a.emit('lobby:open',{game:key}); await ready;
  ready=next(a,'lobbies'); b.emit('lobby:join',{game:key}); await ready;
  let both=Promise.all([next(a,'kutu:state'),next(b,'kutu:state')]);
  a.emit('lobby:start',{game:key});
  const [{game:owner},{game:other}]=await both;
  assert.equal(owner.heroes[0].items.length,2);
  assert.deepEqual(other.heroes[0].items,[]);
  both=Promise.all([next(a,'kutu:state'),next(b,'kutu:state')]);
  a.emit('kutu:action',{key,id:owner.id,revision:0,action:'show:1'});
  const [,shown]=await both;
  assert.deepEqual(shown.game.heroes[0].items,[{type:4,shown:true}]);
  const {s:watcher,info}=await join('Konuk');
  assert.deepEqual(info.munchkin.heroes[0].items,shown.game.heroes[0].items);
  ready=next(watcher,'kutu:state');
  a.emit('kutu:action',{key,id:owner.id,revision:1,action:'hide:1'});
  assert.deepEqual((await ready).game.heroes[0].items,[]);
});
