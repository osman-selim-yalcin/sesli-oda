const {test}=require('node:test');
const assert=require('node:assert/strict');
const takimada=require('../public/takimada-kurallar');
const yedikapi=require('../public/yedikapi-kurallar');
const {startServer,client,ack,next}=require('./helpers');

test('Takımada · ada, yılan sıralı kurulum, mesafe ve karşılıklı takas',()=>{
  const g=takimada.create(['Ada','Deniz','Kum']);
  assert.equal(g.tiles.length,24);
  assert.equal(g.tiles.filter(t=>t.kind<0).length,2);
  assert.ok(g.tiles.every(t=>t.kind<0 ? t.number===0 : t.number>=1 && t.number<=6));
  assert.equal(g.tiles[g.storm].kind,-1);
  for(const p of [0,1,2,2,1,0]) {
    assert.equal(g.turn,p);
    takimada.play(g,takimada.available(g)[0]);
    takimada.play(g,takimada.available(g)[0]);
  }
  assert.equal(g.phase,'roll');
  assert.deepEqual(g.players.map((_,p)=>takimada.score(g,p)),[2,2,2]);
  for(const e of g.edges) assert.ok(!(g.nodes[e.a].level && g.nodes[e.b].level));
  g.phase='build'; g.hand[0]=[3,0,0,0]; g.hand[1]=[0,1,0,0];
  const offer='offer:1:0:1';
  assert.ok(takimada.available(g).includes(offer));
  takimada.play(g,offer); takimada.play(g,'decline'); assert.equal(g.hand[0][0],3);
  takimada.play(g,offer); takimada.play(g,'accept');
  assert.deepEqual(g.hand[0],[2,1,0,0]); assert.deepEqual(g.hand[1],[1,0,0,0]); assert.equal(g.turn,0);
});
test('Takımada · gelgit üretimi, fırtına, banka takası ve 8 puanda zafer',()=>{
  const g=takimada.create(['Ada','Deniz']);
  for(let i=0;i<8;i++) takimada.play(g,takimada.available(g)[0]);
  assert.equal(g.phase,'roll');
  const before=g.hand.map(h=>[...h]);
  takimada.play(g,'roll');
  const mark=g.dice[0];
  const expected=before.map(h=>[...h]);
  g.tiles.forEach((t,k)=>{ if(t.number===mark && k!==g.storm) for(const n of t.corners){ const v=g.nodes[n]; if(v.level) expected[v.owner][t.kind]+=v.level; } });
  assert.deepEqual(g.hand,expected);
  assert.deepEqual(g.gain.map((x,p)=>x.map((n,k)=>before[p][k]+n)),expected);
  // Fırtınanın durduğu arazi üretmez
  const site=g.nodes.findIndex(v=>v.owner===0), tile=g.nodes[site].tiles[0];
  if(g.tiles[tile].kind<0) g.tiles[tile].kind=0; // köşe yalnız lagüne değiyorsa araziye çevir
  g.storm=tile; g.phase='roll'; g.turn=0;
  for(const t of g.tiles) t.number=t.kind<0?0:1;
  const kind=g.tiles[tile].kind, others=g.nodes[site].tiles.filter(k=>k!==tile && g.tiles[k].kind===kind).length;
  const had=g.hand[0][kind];
  let tries=0; do { g.phase='roll'; g.turn=0; g.hand[0][kind]=had; takimada.play(g,'roll'); } while(g.dice[0]!==1 && ++tries<500);
  const fromOtherDocks=g.nodes.filter((v,i)=>i!==site && v.owner===0).reduce((n,v)=>n+v.tiles.filter(k=>k!==tile && g.tiles[k].kind===kind).length,0);
  assert.equal(g.hand[0][kind],had+others+fromOtherDocks);
  assert.match(g.log,/Fırtınadaki arazi üretmedi/);
  // Banka 3:1
  g.hand[0]=[3,0,0,0];
  assert.ok(takimada.available(g).includes('trade:0:2'));
  takimada.play(g,'trade:0:2'); assert.deepEqual(g.hand[0],[0,0,1,0]);
  // Sıra bitince fırtına komşu araziye sürüklenir
  const from=g.storm; takimada.play(g,'end');
  assert.ok(g.tiles[from].near.includes(g.storm)); assert.equal(g.turn,1); assert.equal(g.phase,'roll');
  // Fener 2 puan; 8 puan kazanır
  g.turn=0; g.phase='build'; g.hand[0]=[0,2,2,1];
  const light='light:'+site;
  assert.ok(takimada.available(g).includes(light));
  g.nodes.filter(v=>v.owner===-1).slice(0,5).forEach(v=>{v.owner=0;v.level=1;});
  takimada.play(g,light);
  assert.deepEqual(g.hand[0],[0,0,0,0]); assert.equal(takimada.score(g,0),8); assert.ok(g.done);
});
test('Yedi Kapı · yardım kararı, iksir ve onuncu seviyede zafer',()=>{
  const g=yedikapi.create(['Ay','Gün']);
  Object.assign(g,{phase:'combat',monster:{name:'Dev',strength:12},asked:[],helper:null});
  g.heroes[0].level=9;
  yedikapi.play(g,'help:1');
  assert.deepEqual(yedikapi.available(g),['accept','decline']);
  yedikapi.play(g,'accept'); assert.equal(g.turn,0);
  yedikapi.play(g,'potion'); assert.equal(g.heroes[0].potions,0);
  yedikapi.play(g,'fight'); assert.ok(g.done); assert.equal(g.heroes[0].level,10);
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
  for(const key of ['takimada','yedikapi']){
    let ready=next(a,'lobbies'); a.emit('lobby:open',{game:key}); await ready;
    ready=next(a,'lobbies'); b.emit('lobby:join',{game:key}); await ready;
    ready=next(a,'kutu:state'); a.emit('lobby:start',{game:key});
    const {game}=await ready;
    const engine=key==='takimada'?takimada:yedikapi;
    const packet={key,id:game.id,revision:0,action:engine.available(game)[0]};
    b.emit('kutu:action',packet); await ack(b,'hello',{token:b.token});
    ready=next(a,'kutu:state'); a.emit('kutu:action',packet);
    assert.equal((await ready).game.revision,1);
  }
});

test('Envanter · kuşanma, gizlilik ve aynı yuvadaki eşyanın değiştirilmesi', () => {
  const g = yedikapi.create(['Ay','Gün']);
  const hero = g.heroes[0];
  hero.items.push({type:1, shown:false});
  assert.equal(yedikapi.manage(g,0,'equip:0'),true);
  assert.equal(yedikapi.power(hero),2);
  assert.deepEqual(yedikapi.view(g,'Gün').heroes[0].items,[]);
  assert.equal(yedikapi.manage(g,0,'show:0'),true);
  assert.equal(yedikapi.view(g,'Gün').heroes[0].gear[0],0);
  assert.equal(yedikapi.manage(g,0,'equip:2'),true);
  assert.equal(yedikapi.power(hero),4);
  assert.equal(yedikapi.view(g,'Gün').heroes[0].gear[0],-1);
  assert.equal(yedikapi.manage(g,0,'exchange:0'),true);
  assert.equal(hero.gear[0],1);
  assert.equal(yedikapi.power(hero),4);
  assert.equal(hero.potions,2);
  assert.equal(yedikapi.manage(g,0,'remove:1'),true);
  assert.equal(yedikapi.power(hero),1);
  g.phase='combat';
  assert.equal(yedikapi.manage(g,0,'equip:1'),false);
  assert.equal(yedikapi.manage(g,1,'show:1'),true);
  assert.equal(yedikapi.manage(g,1,'hide:1'),true);
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
  const key='yedikapi';
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
  assert.deepEqual(info.yedikapi.heroes[0].items,shown.game.heroes[0].items);
  ready=next(watcher,'kutu:state');
  a.emit('kutu:action',{key,id:owner.id,revision:1,action:'hide:1'});
  assert.deepEqual((await ready).game.heroes[0].items,[]);
});
