'use strict';

(() => {
  const resources = ['Odun', 'Tuğla', 'Yün', 'Tahıl', 'Cevher'];
  const roadCost = [1, 1, 0, 0, 0];
  const townCost = [1, 1, 1, 1, 0];
  const cityCost = [0, 0, 0, 2, 3];
  const die = () => 1 + Math.floor(Math.random() * 6);
  function shuffle(cards) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }
  function create(names) {
    const tiles = [], nodes = [], edges = [];
    const vertices = new Map(), links = new Map();
    const land = shuffle([0,0,0,0,1,1,1,2,2,2,2,3,3,3,3,4,4,4,-1]);
    const numbers = shuffle([2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12]);
    for (let q = -2; q <= 2; q++) {
      for (let r = -2; r <= 2; r++) {
        if (Math.abs(q + r) > 2) continue;
        const x = 2*q+r, y = 3*r, kind = land.pop();
        const corners = [[0,-2],[1,-1],[1,1],[0,2],[-1,1],[-1,-1]].map(([dx,dy]) => {
          const vx = x+dx, vy = y+dy, key = [vx,vy].join(',');
          if (!vertices.has(key)) {
            vertices.set(key, nodes.length);
            nodes.push({ x:vx, y:vy, owner:-1, level:0, edges:[], tiles:[] });
          }
          const id = vertices.get(key);
          nodes[id].tiles.push(tiles.length);
          return id;
        });
        tiles.push({ x,y,kind,number:kind < 0 ? 0 : numbers.pop(),corners });
        corners.forEach((a,i) => {
          const b = corners[(i+1)%6], key = [Math.min(a,b), Math.max(a,b)].join(',');
          if (links.has(key)) return;
          links.set(key, edges.length);
          nodes[a].edges.push(edges.length);
          nodes[b].edges.push(edges.length);
          edges.push({ a,b,owner:-1 });
        });
      }
    }
    return { players:names, tiles,nodes,edges, hand:names.map(()=>[0,0,0,0,0]), phase:'settle',
      turn:0, setup:0, anchor:null, robber:tiles.findIndex(t=>t.kind<0), dice:[], log:'Başlangıç köyünü seç.', done:false };
  }
  const other = (edge,i) => edge.a === i ? edge.b : edge.a;
  const affordable = (hand,cost) => cost.every((n,i)=>hand[i]>=n);
  const score = (g,p) => g.nodes.reduce((n,v)=>n+(v.owner===p?v.level:0),0);
  function available(g) {
    if (g.done) return [];
    const me = g.turn, hand = g.hand[me], acts=[];
    const hasRoad = i => g.nodes[i].edges.some(e=>g.edges[e].owner===me);
    if (g.phase==='offer') return ['accept','decline'];
    if (g.phase==='roll') return ['roll'];
    if (g.phase==='robber') return g.tiles.flatMap((_,i)=>i===g.robber?[]:['robber:'+i]);
    if (g.phase==='build') {
      acts.push('end');
      for (const [p,stock] of g.hand.entries()) {
        if (p===me) continue;
        for (let give=0;give<5;give++) for (let get=0;get<5;get++) {
          if (give!==get && hand[give] && stock[get]) acts.push(['offer',p,give,get].join(':'));
        }
      }
      for (let i=0;i<5;i++) {
        if (hand[i]<4) continue;
        for (let j=0;j<5;j++) if (i!==j) acts.push('trade:'+i+':'+j);
      }
    }
    g.nodes.forEach((v,i)=>{
      if (g.phase==='build' && v.owner===me && v.level===1 && affordable(hand,cityCost)) acts.push('city:'+i);
      if (g.phase!=='settle' && !(g.phase==='build' && affordable(hand,townCost) && hasRoad(i))) return;
      if (!v.level && v.edges.every(e=>!g.nodes[other(g.edges[e],i)].level)) acts.push('town:'+i);
    });
    g.edges.forEach((e,i)=>{
      if (e.owner!==-1) return;
      const ends = [e.a,e.b];
      if (g.phase==='road' && ends.includes(g.anchor)) acts.push('road:'+i);
      if (g.phase==='build' && affordable(hand,roadCost) && ends.some(n=>g.nodes[n].owner===me || (g.nodes[n].owner===-1 && hasRoad(n)))) acts.push('road:'+i);
    });
    return acts;
  }
  function takeRandom(hand) {
    const cards=hand.flatMap((n,i)=>Array(n).fill(i));
    if (!cards.length) return -1;
    const kind=cards[Math.floor(Math.random()*cards.length)];
    hand[kind]--;
    return kind;
  }
  function play(g,action) {
    const [type,index,output]=action.split(':');
    const i=Number(index), me=g.turn, hand=g.hand[me], name=g.players[me];
    const pay=cost=>cost.forEach((n,k)=>hand[k]-=n);
    if (type==='roll') {
      g.dice=[die(),die()];
      const sum=g.dice[0]+g.dice[1];
      g.log=name+' zar attı · '+sum;
      g.phase=sum===7?'robber':'build';
      if (sum===7) {
        for (const h of g.hand) {
          const count=h.reduce((a,b)=>a+b,0);
          if (count>7) for (let n=0;n<Math.floor(count/2);n++) takeRandom(h);
        }
      } else {
        g.tiles.forEach((t,k)=>{
          if (t.number!==sum || k===g.robber) return;
          for (const n of t.corners) {
            const v=g.nodes[n];
            if (v.level) g.hand[v.owner][t.kind]+=v.level;
          }
        });
      }
    } else if (type==='robber') {
      g.robber=i;
      const owners=g.tiles[i].corners.map(n=>g.nodes[n].owner).filter(p=>p>=0 && p!==me && g.hand[p].some(Boolean));
      const victim=shuffle([...new Set(owners)])[0];
      if (victim!==undefined) hand[takeRandom(g.hand[victim])]++;
      g.phase='build';
      g.log=name+' haydudu taşıdı.';
    } else if (type==='town' || type==='city') {
      const v=g.nodes[i];
      if (g.phase==='settle') {
        g.anchor=i;
        g.phase='road';
        if (g.setup>=g.players.length) for (const k of v.tiles) if (g.tiles[k].kind>=0) hand[g.tiles[k].kind]++;
      } else pay(type==='town'?townCost:cityCost);
      v.owner=me;
      v.level=type==='town'?1:2;
      g.log=name+(v.level===1?' köy kurdu.':' şehir kurdu.');
    } else if (type==='road') {
      g.edges[i].owner=me;
      g.log=name+' yol yaptı.';
      if (g.phase==='road') {
        g.setup++;
        const count=g.players.length;
        g.phase=g.setup===2*count?'roll':'settle';
        g.turn=g.setup<count?g.setup:Math.max(0,2*count-1-g.setup);
      } else pay(roadCost);
    } else if (type==='offer') {
      const get=Number(action.split(':')[3]);
      g.offer={from:me,give:Number(output),get}; g.turn=i; g.phase='offer';
      g.log=name+' sana 1 '+resources[g.offer.give]+' verip 1 '+resources[get]+' istiyor.';
    } else if (type==='accept' || type==='decline') {
      const {from,give,get}=g.offer;
      if (type==='accept') {
        g.hand[from][give]--; hand[give]++; hand[get]--; g.hand[from][get]++;
      }
      g.offer=null; g.turn=from; g.phase='build';
      g.log=name+(type==='accept'?' takası kabul etti.':' takası reddetti.');
    } else if (type==='trade') {
      hand[i]-=4;
      hand[Number(output)]++;
      g.log=name+' bankayla takas yaptı.';
    } else if (type==='end') {
      g.turn=(me+1)%g.players.length;
      g.phase='roll';
    }
    if (score(g,me)>=10) { g.done=true; g.log=name+' 10 puana ulaştı ve kazandı!'; }
  }
  function bot(g,acts) {
    if (g.phase==='offer') return g.hand[g.turn][g.offer.get]>=g.hand[g.turn][g.offer.give]?'accept':'decline';
    const prefix=x=>acts.filter(a=>a.startsWith(x+':'));
    const sites=[...prefix('city'),...prefix('town')];
    if (sites.length) {
      const quality=a=>g.nodes[Number(a.split(':')[1])].tiles.reduce((n,k)=>n+(g.tiles[k].number?6-Math.abs(7-g.tiles[k].number):0),0);
      return shuffle(sites).sort((a,b)=>quality(b)-quality(a))[0];
    }
    const h=g.hand[g.turn];
    const trades=prefix('trade').filter(a=>{const [,give,get]=a.split(':');return h[get]<2 && h[give]-4>=h[get];});
    if (trades.length) return shuffle(trades)[0];
    const roads=prefix('road');
    if (roads.length) return shuffle(roads)[0];
    return acts.includes('end')?'end':shuffle([...acts])[0];
  }
  const rules={create,available,play,bot,score,resources};
  if (typeof module==='object' && module.exports) module.exports=rules;
  else window.CatanRules=rules;
})();
