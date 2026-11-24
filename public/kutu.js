'use strict';

(() => {
  const titles = { catan:'Catan', munchkin:'Munchkin' };
  const rules = { catan:window.CatanRules, munchkin:window.MunchkinRules };
  const slots = ['Başlık','Zırh','Silah'];
  const colors = ['#f78c64','#6ac5ff','#de96f3','#a8d87a'];
  const terrain = ['#315f4a','#975344','#7e9256','#ab914c','#586879','#aa9079'];
  const el = (tag,text,cls) => Object.assign(document.createElement(tag), { textContent:text || '',className:cls || '' });
  function button(label, action) {
    const b=el('button',label); b.type='button'; b.onclick=action; return b;
  }
  const svgEl=(tag,attrs)=> {
    const e=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [a,v] of Object.entries(attrs)) e.setAttribute(a,v);
    return e;
  };

  function island(g, actions, submit) {
    const svg=svgEl('svg',{viewBox:'-126 -116 252 232',class:'catan-map','aria-label':'Ada, yollar ve yerleşimler'});
    const choices=new Set(actions);
    function interactive(shape,action,label) {
      if (!choices.has(action)) return;
      shape.classList.add('catan-target');
      shape.setAttribute('tabindex','0'); shape.setAttribute('role','button'); shape.setAttribute('aria-label',label);
      shape.onclick=()=>submit(action);
      shape.onkeydown=e=>{if (['Enter',' '].includes(e.key)) { e.preventDefault(); submit(action); }};
    }
    const x=v=>v.x*22, y=v=>v.y*13;
    for (const [i,t] of g.tiles.entries()) {
      const poly=svgEl('polygon',{points:t.corners.map(n=>x(g.nodes[n])+','+y(g.nodes[n])).join(' '),fill:terrain[t.kind<0?5:t.kind]});
      const label=t.kind<0?'Çöl':rules.catan.resources[t.kind];
      interactive(poly,'robber:'+i,'Haydudu taşı · '+label+' '+t.number);
      svg.append(poly);
      for (const [dy,text] of [[-2,label],[8,(t.number||'')+(g.robber===i?' ◆':'')]]) {
        const txt=svgEl('text',{x:x(t),y:y(t)+dy,'text-anchor':'middle'}); txt.textContent=text; svg.append(txt);
      }
    }
    for (const [i,e] of g.edges.entries()) {
      const a=g.nodes[e.a], b=g.nodes[e.b], allowed=choices.has('road:'+i);
      const line=svgEl('line',{x1:x(a),y1:y(a),x2:x(b),y2:y(b),stroke:e.owner>=0?colors[e.owner]:allowed?'white':'#283335','stroke-width':e.owner>=0?3.5:allowed?3:1,'pointer-events':'none'});
      if (allowed) line.setAttribute('stroke-dasharray','4 2');
      svg.append(line);
      if (allowed) {
        const hit=svgEl('line',{x1:x(a),y1:y(a),x2:x(b),y2:y(b),stroke:'transparent','stroke-width':9});
        interactive(hit,'road:'+i,'Yol yap · '+(i+1)); svg.append(hit);
      }
    }
    for (const [i,n] of g.nodes.entries()) {
      const action=(n.level?'city:':'town:')+i, allowed=choices.has(action);
      if (!n.level && !allowed) continue;
      const shape=n.level===2?svgEl('rect',{x:x(n)-4,y:y(n)-4,width:8,height:8}):svgEl('circle',{cx:x(n),cy:y(n),r:allowed?4:3.4});
      shape.setAttribute('fill',n.level?colors[n.owner]:'#172326');
      shape.setAttribute('stroke',allowed?'white':'#263034');
      shape.setAttribute('stroke-width',allowed?1.8:1);
      interactive(shape,action,(n.level?'Şehre yükselt':'Köy kur')+' · '+(i+1)); svg.append(shape);
    }
    return svg;
  }

  for (const key of Object.keys(titles)) {
    const engine=rules[key], panel=document.getElementById('game-'+key);
    let game=null, local=false, robot=false, timer;
    const title=titles[key], lobby=el('div','','lobby'), match=el('div','','kutu-match');
    lobby.id='lobby-'+key;
    const guide=el('details','','yorunge-guide');
    guide.append(el('summary','Nasıl oynanır?'),el('p',key==='catan'?
      'İki başlangıç köyü ve yolunu haritaya yerleştir. Zarın gösterdiği araziler komşu köylere bir, şehirlere iki kaynak verir. Beyaz halkalara köy, kesikli çizgilere yol yap. Kendi köyünü seçerek şehre yükselt. Yol 1 odun + 1 tuğla, köy bunlara ek 1 yün + 1 tahıl, şehir 2 tahıl + 3 cevher tutar. Bir oyuncuya bire bir takas teklif edebilir veya bankada 4 aynı kaynağı 1 kaynakla değiştirebilirsin. Yedi gelince yediden çok kartı olanlar yarısını verir; haydudu taşıdığın arazide üretim durur. Köy 1, şehir 2 puan. İlk 10 puan kazanır.':
      'Kapı açınca canavar, hazine veya lanet gelir. Gücün seviyen ve ekipmanlarının toplamıdır. Canavarı yenmek için gücün onunkini geçmeli. İksir bu savaşa +3 verir. Bir oyuncudan yardım isteyebilirsin. Kabul ederse gücünü ekler ve zaferde hazine alır. Kazanınca bir seviye ve hazine alırsın. Daha güçlü ekipman otomatik kuşanılır. Kaçış zarında 5 veya 6 kurtarır. Savaşla 10. seviyeye çıkan kazanır.'));
    panel.append(lobby,match,guide);
    function localLobby() {
      if (!local) return false;
      lobby.hidden=Boolean(game&&!game.done);
      if (!lobby.hidden) lobby.replaceChildren(button('Bota karşı oyna',()=>start(true,2)), ...[2,3,4].map(n=>button(n+' kişi · aynı cihaz',()=>start(false,n))));
      return true;
    }
    LOBBY[key]={title,tab:key,running:()=>Boolean(game&&!game.done),last:()=>game,localLobby,hint:'2–4 oyuncuyla veya oda botuyla oynanır.'};
    function start(bot,n) {
      clearTimeout(timer);
      robot=bot;
      game=engine.create(Array.from({length:n},(_,i)=>bot && i===1?'Bot 🤖':'Oyuncu '+(i+1)));
      render();
    }
    function apply(action) {
      engine.play(game,action);
      render();
      if (robot && !game.done && game.turn===1) timer=setTimeout(()=>apply(engine.bot(game,engine.available(game))),500);
    }
    function submit(action) {
      if (local) {
        if (action==='leave') { clearTimeout(timer); game.done=true; game.log='Maç sona erdi.'; return render(); }
        if (!(robot && game.turn===1) && engine.available(game).includes(action)) apply(action);
      } else socket.emit('kutu:action',{key,id:game.id,revision:game.revision,action});
    }
    function render() {
      if (!localLobby()) renderLobby(key);
      match.replaceChildren(); match.hidden=!game;
      if (!game) return;
      const g=game, me=local?(robot?0:g.turn):g.players.indexOf(myName);
      const mine=!g.done && me===g.turn, acts=mine?engine.available(g):[];
      const header=el('div','','kutu-head');
      header.append(el('h3',g.done?'Maç bitti':'Sıra · '+g.players[g.turn]));
      if (!g.done && me>=0) header.append(button('Maçı bitir',()=>{if (window.confirm('Maç bitsin mi?')) submit('leave');}));
      match.append(header,el('p',g.log,'kutu-log'));
      const scores=el('div','','kutu-scores');
      g.players.forEach((name,i)=>{
        const chip=el('span',name+' · '+(key==='catan'?engine.score(g,i)+' puan':'Sv. '+g.heroes[i].level));
        chip.style.borderColor=colors[i]; scores.append(chip);
      });
      match.append(scores);
      const actions=el('div','','kutu-actions');
      if (key==='catan') {
        const hints={settle:'Başlangıç köyü için bir halka seç.',road:'Başlangıç yolunu kesikli çizgilerden seç.',robber:'Haydudu taşımak için bir arazi seç.',build:'İnşa edebilir, takas yapabilir veya sıranı bitirebilirsin.',roll:'Üretim için zar at.',offer:'Takas teklifine yanıt ver.'};
        if (mine) match.append(el('p',hints[g.phase]));
        match.append(island(g,acts,submit));
        const hand=g.hand[me<0?g.turn:me];
        match.append(el('p',engine.resources.map((r,i)=>r+' '+hand[i]).join(' · ')));
        const offers=acts.filter(a=>a.startsWith('offer:'));
        if (offers.length) {
          const select=el('select'); select.setAttribute('aria-label','Oyuncuyla takas');
          for (const a of offers) {
            const [,p,give,get]=a.split(':');
            select.add(new Option(g.players[p]+' · '+engine.resources[give]+' ver, '+engine.resources[get]+' al',a));
          }
          actions.append(select,button('Takas öner',()=>submit(select.value)));
        }
        if (acts.includes('roll')) actions.append(button('Zar at',()=>submit('roll')));
        const trades=acts.filter(a=>a.startsWith('trade:'));
        if (trades.length) {
          const select=el('select'); select.setAttribute('aria-label','Banka takası');
          for (const a of trades) { const [,i,j]=a.split(':'); select.add(new Option('4 '+engine.resources[i]+' → 1 '+engine.resources[j],a)); }
          actions.append(select,button('Takas yap',()=>submit(select.value)));
        }
      } else {
        const hero=g.heroes[g.phase==='help'?g.leader:g.turn],card=el('div','','kutu-encounter');
        card.append(el('small',g.monster?'KARŞILAŞMA':'ZİNDAN KAPISI'),el('h3',g.monster?.name || g.players[g.turn]),
          el('p','Gücün '+(engine.power(hero)+g.boost)+(g.monster?' · Canavar '+g.monster.strength:'')+' · İksir '+hero.potions));
        match.append(card,el('p',hero.gear.map((item,i)=>slots[i]+' · '+(engine.gear[item]?.[0]||'Boş')).join('   /   ')));
        const labels={door:'Kapıyı aç',fight:'Savaş',potion:'İksir iç (+3)',flee:'Kaçmayı dene'};
        for (const a of acts.filter(a=>a.startsWith('help:'))) actions.append(button(g.players[Number(a.slice(5))]+' yardım etsin',()=>submit(a)));
        for (const a of acts) if (labels[a]) actions.append(button(labels[a],()=>submit(a)));
      }
      if (acts.includes('accept')) actions.append(button('Kabul et',()=>submit('accept')),button('Reddet',()=>submit('decline')));
      if (acts.includes('end')) actions.append(button('Sırayı bitir',()=>submit('end')));
      match.append(actions);
    }
    function sync(state,supported) {
      if (local && !supported) return;
      clearTimeout(timer); local=!supported; game=state || null; render();
    }
    socket.on('kutu:state',data=>{if (data.key===key) sync(data.game,true);});
    LOBBY[key].sync=sync;
    render();
  }
})();
