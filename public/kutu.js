'use strict';

(() => {
  const titles = { catan:'Catan', munchkin:'Munchkin' };
  const rules = { catan:window.CatanRules, munchkin:window.MunchkinRules };
  const slots = ['Başlık','Zırh','Silah'];
  const colors = ['#f78c64','#6ac5ff','#de96f3','#a8d87a'];
  const materials = ['wood','brick','wool','grain','ore'];
  const itemIcons = ['helm','crown','armor','cloak','spoon','mace'];
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

  function artIcon(name, attrs = {}) {
    const svg = svgEl('svg', { viewBox: '0 0 32 32', class: 'kutu-icon', 'aria-hidden': 'true', ...attrs });
    svg.append(svgEl('use', { href: '/icons/kutu.svg#' + name }));
    return svg;
  }
  function sectionTitle(text, icon) {
    const heading = el('h4', text, 'kutu-section-title');
    if (icon) heading.prepend(artIcon(icon));
    return heading;
  }
  function iconButton(text, action, icon, cls = '') {
    const b = button(text, action);
    if (icon) b.prepend(artIcon(icon));
    b.className = cls;
    return b;
  }
  function startBanner(key, title, subtitle) {
    const banner = el('div', '', 'kutu-banner kutu-banner-' + key);
    banner.append(el('h2', title), el('p', subtitle));
    return banner;
  }

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
      const stamp = artIcon(materials[t.kind] || 'desert', { x:x(t)-8, y:y(t)-16, width:16, height:16, class:'catan-stamp' });
      const tip = svgEl('title', {}); tip.textContent = label;
      poly.append(tip);
      svg.append(stamp);
      const token = svgEl('circle', { cx:x(t), cy:y(t)+7, r:6.4, class:'catan-token' });
      const number = svgEl('text', { x:x(t), y:y(t)+9.5, 'text-anchor':'middle', class: [6,8].includes(t.number) ? 'frequent' : '' });
      number.textContent = g.robber===i ? '◆' : t.number || '–';
      svg.append(token, number);
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
      if (n.level) svg.append(artIcon(n.level===2?'city':'town', {x:x(n)-4.6,y:y(n)-5.4,width:9.2,height:10,class:'catan-building'}));
    }
    return svg;
  }

  for (const key of Object.keys(titles)) {
    const engine=rules[key], panel=document.getElementById('game-'+key);
    let game=null, local=false, robot=false, timer;
    let bagOpen=false, buildFilter='', seat=-1;
    panel.classList.add('kutu-game');
    const title=titles[key], lobby=el('div','','lobby'), match=el('div','','kutu-match');
    lobby.id='lobby-'+key;
    const guide=el('details','','yorunge-guide');
    guide.append(el('summary','Nasıl oynanır?'),el('p',key==='catan'?
      'İki başlangıç köyü ve yolunu haritaya yerleştir. Zarın gösterdiği araziler komşu köylere bir, şehirlere iki kaynak verir. Beyaz halkalara köy, kesikli çizgilere yol yap. Kendi köyünü seçerek şehre yükselt. Yol 1 odun + 1 tuğla, köy bunlara ek 1 yün + 1 tahıl, şehir 2 tahıl + 3 cevher tutar. Bir oyuncuya bire bir takas teklif edebilir veya bankada 4 aynı kaynağı 1 kaynakla değiştirebilirsin. Yedi gelince yediden çok kartı olanlar yarısını verir; haydudu taşıdığın arazide üretim durur. Köy 1, şehir 2 puan. İlk 10 puan kazanır.':
      'Kapı açınca canavar, hazine veya lanet gelir. Gücün seviyen ve ekipmanlarının toplamıdır. Canavarı yenmek için gücün onunkini geçmeli. İksir bu savaşa +3 verir. Bir oyuncudan yardım isteyebilirsin. Kabul ederse gücünü ekler ve zaferde hazine alır. Kazanınca bir seviye ve hazine alırsın. Ganimet çantaya girer. Kendi sıranda kapı açmadan önce veya kamp sırasında eşya kuşanabilir, çıkarabilir ya da çantadaki bir eşyayı iksire çevirebilirsin. Her eşyayı masaya gösterme ve gizleme seçimi ayrıdır. Kaçış zarında 5 veya 6 kurtarır. Savaşla 10. seviyeye çıkan kazanır.'));
    panel.append(lobby,match,guide);
    function localLobby() {
      if (!local) return false;
      lobby.hidden=Boolean(game&&!game.done);
      if (!lobby.hidden) {
        lobby.className='lobby kutu-start';
        const options=el('div','','kutu-start-options'), select=el('select');
        select.setAttribute('aria-label','Aynı cihazdaki oyuncu sayısı');
        for (const n of [2,3,4]) select.add(new Option(n+' oyuncu',String(n)));
        const group=el('div','','kutu-choice');
        group.append(select,button('Aynı cihazda oyna',()=>start(false,Number(select.value))));
        options.append(iconButton('Bota karşı oyna',()=>start(true,2),key==='catan'?'dice':'mace','primary'),group);
        lobby.replaceChildren(startBanner(key,title,key==='catan'?'Adanın ilk yollarını döşe, köylerini şehirlere dönüştür.':'Kapıyı aç, ganimeti topla ve 10. seviyeye ulaş.'),options);
      }
      return true;
    }
    LOBBY[key]={title,tab:key,running:()=>Boolean(game&&!game.done),last:()=>game,localLobby,hint:'2–4 oyuncuyla veya oda botuyla oynanır.'};
    function start(bot,n) {
      clearTimeout(timer);
      robot=bot; bagOpen=bot; seat=-1; buildFilter='';
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
        const player = robot ? 0 : game.turn;
        if (key==='munchkin' && engine.manage(game,player,action)) return render();
        if (!(robot && game.turn===1) && engine.available(game).includes(action)) apply(action);
      } else socket.emit('kutu:action',{key,id:game.id,revision:game.revision,action});
    }
    function render() {
      if (!localLobby()) renderLobby(key);
      match.replaceChildren(); match.hidden=!game;
      if (!game) return;
      const g=game, me=local?(robot?0:g.turn):g.players.indexOf(myName);
      if (seat!==me) {
        if (seat>=0 && local && !robot) bagOpen=false;
        buildFilter=''; seat=me;
      }
      const mine=!g.done && me===g.turn, acts=mine?engine.available(g):[];
      const header=el('div','','kutu-head');
      header.append(el('h3',g.done?'Maç bitti':'Sıra · '+g.players[g.turn]));
      if (!g.done && me>=0) header.append(button('Maçı bitir',()=>{if (window.confirm('Maç bitsin mi?')) submit('leave');}));
      match.append(header);
      const scores=el('div','','kutu-scores');
      g.players.forEach((name,i)=>{
        const chip=el('span',name+' · '+(key==='catan'?engine.score(g,i)+' puan':'Sv. '+g.heroes[i].level));
        if (!g.done && i===g.turn) chip.classList.add('active');
        chip.style.borderColor=colors[i]; scores.append(chip);
      });
      match.append(scores);
      const actions=el('div','','kutu-actions');
      if (key==='catan') {
        const hints={settle:'Başlangıç köyü için bir halka seç.',road:'Başlangıç yolunu kesikli çizgilerden seç.',robber:'Haydudu taşımak için bir arazi seç.',build:'İnşa edebilir, takas yapabilir veya sıranı bitirebilirsin.',roll:'Üretim için zar at.',offer:'Takas teklifine yanıt ver.'};
        const mapArea=el('div','','catan-atlas');
        const side=el('aside','','catan-tableau');
        const layout=el('div','','catan-layout');
        layout.append(mapArea,side); match.append(layout);
        const banner=startBanner(key,'Catan',mine?hints[g.phase]:g.log);
        mapArea.append(banner);
        const filters=['town','city','road'];
        if (!acts.some(a=>a.startsWith(buildFilter+':'))) buildFilter='';
        const mapped=acts.filter(a=>!buildFilter || a.startsWith(buildFilter+':'));
        mapArea.append(island(g,mapped,submit));
        const roll=el('div','','catan-roll');
        if (g.dice.length) {
          const diceFaces=['⚀','⚁','⚂','⚃','⚄','⚅'];
          const faces=el('strong',g.dice.map(n=>diceFaces[n-1]).join(' '));
          faces.setAttribute('aria-label','Zarlar '+g.dice.join(' ve ')); roll.append(faces);
        }
        roll.append(el('span',g.log));
        mapArea.append(roll);
        const hand=g.hand[me<0?g.turn:me], rack=el('div','','catan-resources');
        side.append(sectionTitle(me<0?'Aktif oyuncunun kaynakları':'Kaynaklarım'),rack);
        engine.resources.forEach((name,i)=>{
          const tile=el('div','','catan-resource');
          tile.append(artIcon(materials[i]),el('b',String(hand[i])),el('small',name));
          rack.append(tile);
        });
        const builds=el('div','','catan-builds');
        side.append(sectionTitle('İnşa planı'),builds);
        const prices={town:[0,1,2,3],city:[3,3,4,4,4],road:[0,1]};
        const names={town:'Köy',city:'Şehir',road:'Yol'};
        for (const kind of filters) {
          const row=button('',()=>{buildFilter=buildFilter===kind?'':kind;render();});
          row.className='catan-blueprint';
          row.disabled=!acts.some(a=>a.startsWith(kind+':'));
          row.setAttribute('aria-pressed',String(buildFilter===kind));
          const cost=el('span','','catan-cost');
          const counts=materials.map((_,i)=>prices[kind].filter(k=>k===i).length);
          const free=(g.phase==='settle' && kind==='town') || (g.phase==='road' && kind==='road');
          if (free) cost.append('Kurulumda ücretsiz');
          else counts.forEach((n,i)=>{ if(n) cost.append(artIcon(materials[i]),String(n)); });
          row.title=free?'Kurulumda ücretsiz':counts.map((n,i)=>n?n+' '+engine.resources[i]:'').filter(Boolean).join(', ');
          row.append(artIcon(kind),el('strong',names[kind]),cost); builds.append(row);
        }
        side.append(actions);
        const offers=acts.filter(a=>a.startsWith('offer:'));
        if (offers.length) {
          const select=el('select'); select.setAttribute('aria-label','Oyuncuyla takas');
          for (const a of offers) {
            const [,p,give,get]=a.split(':');
            select.add(new Option(g.players[p]+' · '+engine.resources[give]+' ver, '+engine.resources[get]+' al',a));
          }
          actions.append(select,iconButton('Takas öner',()=>submit(select.value),'trade'));
        }
        if (acts.includes('roll')) actions.append(iconButton('Zar at',()=>submit('roll'),'dice','primary'));
        const trades=acts.filter(a=>a.startsWith('trade:'));
        if (trades.length) {
          const select=el('select'); select.setAttribute('aria-label','Banka takası');
          for (const a of trades) { const [,i,j]=a.split(':'); select.add(new Option('4 '+engine.resources[i]+' → 1 '+engine.resources[j],a)); }
          actions.append(select,iconButton('Takas yap',()=>submit(select.value),'trade'));
        }
      } else {
        const hero=g.heroes[g.phase==='help'?g.leader:g.turn];
        const card=startBanner(key,g.monster?.name || (g.done?'Zindan yolculuğu':'Zindan kapısı'),g.log);
        card.classList.add('kutu-encounter');
        const stats=el('div','','dungeon-stats');
        for (const [icon,label,value] of [['mace','Güç',engine.power(hero)+g.boost],['potion','İksir',hero.potions],...(g.monster?[['monster','Canavar',g.monster.strength]]:[])]) {
          const stat=el('span'); stat.append(artIcon(icon),el('b',String(value)),label); stats.append(stat);
        }
        card.append(stats);
        match.append(card,actions);
        const labels={door:'Kapıyı aç',fight:'Savaş',potion:'İksir iç (+3)',flee:'Kaçmayı dene'};
        for (const a of acts.filter(a=>a.startsWith('help:'))) actions.append(button(g.players[Number(a.slice(5))]+' yardım etsin',()=>submit(a)));
        for (const a of acts) if (labels[a]) actions.append(iconButton(labels[a],()=>submit(a),({door:'door',fight:'mace',potion:'potion'})[a],a==='door'||a==='fight'?'primary':''));
      }
      if (acts.includes('accept')) actions.append(button('Kabul et',()=>submit('accept')),button('Reddet',()=>submit('decline')));
      if (acts.includes('end')) actions.append(button('Sırayı bitir',()=>submit('end')));
      if (key==='munchkin') {
        const own=me>=0?g.heroes[me]:null;
        if (own) {
          const bag=el('section','','dungeon-bag');
          const bar=el('div','','bag-bar');
          const toggle=iconButton(bagOpen?'Çantayı kapat':'Çantamı aç',()=>{bagOpen=!bagOpen; render();},'bag');
          toggle.setAttribute('aria-expanded',String(bagOpen));
          bar.append(sectionTitle('Envanterim'),toggle); bag.append(bar);
          if (bagOpen) {
            const choices=new Set(engine.inventoryActions(g,me)), rack=el('div','','equipment-rack');
            for (const [slot,label] of slots.entries()) {
              const index=own.gear[slot], item=own.items[index];
              const tile=el('div','','equipment-slot'+(item?' worn':''));
              tile.append(artIcon(item?itemIcons[item.type]:['helm','armor','mace'][slot]),el('small',label),el('b',item?engine.gear[item.type][0]:'Boş'));
              rack.append(tile);
            }
            bag.append(rack,el('p',g.done?'Maç tamamlandı.':g.turn===me&&['door','camp'].includes(g.phase)?'Kuşandığın eşya gücüne eklenir. Masaya göstermek ayrı bir seçim.':'Kapı önünde veya kampta sıra sana geldiğinde kuşanabilirsin.','bag-note'));
            const grid=el('div','','loot-grid');
            for (const [index,item] of own.items.entries()) {
              const [name,slot,bonus]=engine.gear[item.type], worn=own.gear.includes(index);
              const tile=el('article','','loot-card'+(worn?' worn':''));
              const img=el('div','','loot-art'); img.append(artIcon(itemIcons[item.type]),el('b','+'+bonus));
              const body=el('div','','loot-body');
              body.append(el('small',slots[slot]+' · '+(worn?'Kuşanıldı':'Çantada')),el('strong',name));
              const controls=el('div','','loot-controls');
              const control=(text,cmd)=>{
                const action=cmd+':'+index,b=button(text,()=>submit(action));
                b.disabled=!choices.has(action); return b;
              };
              const visible=control(item.shown?'Masadan gizle':'Masaya göster',item.shown?'hide':'show');
              visible.prepend(artIcon('eye'));
              visible.setAttribute('aria-pressed',String(item.shown));
              controls.append(control(worn?'Çıkar':'Kuşan',worn?'remove':'equip'),visible);
              if (!worn && choices.has('exchange:'+index)) {
                const exchange=button('İksire çevir',()=>{ if (window.confirm(name+' bir iksire çevrilsin mi?')) submit('exchange:'+index); });
                exchange.className='loot-exchange'; controls.append(exchange);
              }
              tile.append(img,body,controls); grid.append(tile);
            }
            if (!own.items.length) grid.append(el('p','Çantan boş. Kapı açarak ganimet bulabilirsin.'));
            bag.append(grid);
          }
          match.append(bag);
        }
        const display=el('section','','loot-display');
        display.append(sectionTitle('Masadaki eşyalar'));
        for (const [i,h] of g.heroes.entries()) for (const [index,item] of h.items.entries()) {
          if (!item.shown) continue;
          const entry=el('span','','displayed-item');
          entry.append(artIcon(itemIcons[item.type]),el('span',g.players[i]+' · '+engine.gear[item.type][0]+(h.gear.includes(index)?' · kuşanıldı':'')));
          display.append(entry);
        }
        if (display.children.length===1) display.append(el('p','Henüz kimse eşya göstermedi.','bag-note'));
        match.append(display);
      }
    }
    function sync(state,supported) {
      if (local && !supported) return;
      if (!state || game?.id!==state.id) { bagOpen=false; seat=-1; buildFilter=''; }
      clearTimeout(timer); local=!supported; game=state || null; render();
    }
    socket.on('kutu:state',data=>{if (!local && data.key===key) sync(data.game,true);});
    LOBBY[key].sync=sync;
    render();
  }
})();
