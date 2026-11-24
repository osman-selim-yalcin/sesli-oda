'use strict';

(() => {
  const monsters = ['Vergi Ejderi','Homurdanan Sandık','Paslı Golem','Yankı Cini','Uykusuz Muhafız','Çorap Hırsızı','Kayıp Merdiven'];
  const gear = [['Çaydanlık Miğfer',0,1],['Pusula Tacı',0,3],['Yamalı Zırh',1,2],['Ayna Pelerini',1,4],['Tahta Kaşık',2,2],['Çınlayan Topuz',2,4]];
  const pick = list => list[Math.floor(Math.random()*list.length)];
  const die = () => 1+Math.floor(Math.random()*6);
  function makeHero() {
    return {
      level: 1, gear: [-1, -1, -1], potions: 1,
      items: [0, 4].map(type => ({ type, shown: false })),
    };
  }
  function power(hero) {
    if (hero.combatPower !== undefined) return hero.combatPower;
    return hero.gear.reduce((total, index) => total + (gear[hero.items[index]?.type]?.[2] || 0), hero.level);
  }
  function create(players) {
    return { players, turn: 0, phase: 'door', heroes: players.map(makeHero),
      monster: null, boost: 0, done: false, log: 'Zindanın ilk kapısı önündesin.' };
  }
  function inventoryActions(g, player) {
    if (g.done || !g.heroes[player]) return [];
    const hero = g.heroes[player];
    const canDress = g.turn === player && ['door', 'camp'].includes(g.phase);
    return hero.items.flatMap((item, index) => {
      const equipped = hero.gear.includes(index);
      const actions = [(item.shown ? 'hide:' : 'show:') + index];
      if (canDress) {
        actions.push((equipped ? 'remove:' : 'equip:') + index);
        if (!equipped) actions.push('exchange:' + index);
      }
      return actions;
    });
  }
  function manage(g, player, action) {
    if (!inventoryActions(g, player).includes(action)) return false;
    const [command, num] = action.split(':');
    const index = Number(num);
    const hero = g.heroes[player];
    const item = hero.items[index], slot = gear[item.type][1];
    if (command === 'equip') hero.gear[slot] = index;
    if (command === 'remove') hero.gear[slot] = -1;
    if (command === 'show' || command === 'hide') item.shown = command === 'show';
    if (command === 'exchange') {
      hero.items.splice(index, 1);
      hero.gear = hero.gear.map(i => i > index ? i - 1 : i);
      hero.potions++;
    }
    return true;
  }
  // Her alıcı kendi çantasını, diğer kahramanların yalnız sergilediği eşyaları alır.
  function view(g, name) {
    if (!g) return null;
    return { ...g, heroes: g.heroes.map((hero, player) => {
      if (g.players[player] === name) return hero;
      const items = [], slots = [-1, -1, -1];
      hero.items.forEach((item, index) => {
        if (!item.shown) return;
        const slot = hero.gear.indexOf(index);
        if (slot >= 0) slots[slot] = items.length;
        items.push(item);
      });
      return { level: hero.level, potions: hero.potions, combatPower: power(hero), gear: slots, items };
    }) };
  }
  function available(g) {
    if (g.done) return [];
    if (g.phase==='help') return ['accept','decline'];
    if (g.phase==='door') return ['door'];
    if (g.phase==='camp') return ['end'];
    const acts=['fight','flee'];
    if (g.heroes[g.turn].potions) acts.push('potion');
    if (g.helper===null) g.players.forEach((_,i)=>{ if (i!==g.turn && !g.asked.includes(i)) acts.push('help:'+i); });
    return acts;
  }
  function treasure(h) {
    h.items.push({ type: Math.floor(Math.random() * gear.length), shown: false });
    return 'Çantaya bir eşya eklendi.';
  }
  function play(g,action) {
    const h=g.heroes[g.turn], name=g.players[g.turn];
    if (action==='door') {
      g.boost=0; g.helper=null; g.asked=[];
      const roll=die();
      if (roll===1) {
        h.level=Math.max(1,h.level-1); g.log='Lanetli ayna! '+name+' bir seviye kaybetti (en az 1).'; g.phase='camp';
      } else if (roll===2) {
        g.log='Hazine odası! '+treasure(h); g.phase='camp';
      } else {
        g.monster={name:pick(monsters),strength:Math.max(1,h.level+die()+die()-5)};
        g.log=g.monster.name+' kapıyı tutuyor.'; g.phase='combat';
      }
    } else if (action.startsWith('help:')) {
      const helper=Number(action.slice(5));
      g.leader=g.turn; g.turn=helper; g.asked.push(helper); g.phase='help';
      g.log=name+' yardım istiyor. Kazanırsanız yardımcı da hazine alır.';
    } else if (action==='accept' || action==='decline') {
      if (action==='accept') { g.helper=g.turn; g.boost+=power(h); }
      g.log=name+(action==='accept'?' savaşa katıldı.':' yardımı reddetti.');
      g.turn=g.leader; g.phase='combat';
    } else if (action==='potion') {
      h.potions--; g.boost+=3; g.log=name+' iksir içti. Bu savaşta +3 güç.';
    } else if (action==='fight' || action==='flee') {
      if (action==='fight' && power(h)+g.boost>g.monster.strength) {
        h.level++;
        g.log=name+' savaşı kazandı. Seviye '+h.level+' · '+treasure(h);
        if (g.helper!==null) g.log+=' '+g.players[g.helper]+' · '+treasure(g.heroes[g.helper]);
        if (h.level===10) { g.done=true; g.log=name+' 10. seviyeye ulaştı ve kazandı!'; }
      } else {
        const roll=die();
        if (roll>=5) g.log=name+' kaçtı. Zar '+roll+'.';
        else { h.level=Math.max(1,h.level-1); g.log=name+' yakalandı. Zar '+roll+' · Seviye '+h.level+'.'; }
      }
      g.phase='camp'; g.monster=null; g.boost=0;
    } else if (action==='end') {
      g.turn=(g.turn+1)%g.players.length; g.phase='door'; g.log='Sıradaki kapıyı aç.';
    }
  }
  function dressBot(g) {
    if (!['door', 'camp'].includes(g.phase)) return;
    const hero = g.heroes[g.turn];
    hero.items.forEach(({type}, index) => {
      const [, slot, bonus] = gear[type];
      const worn = hero.items[hero.gear[slot]];
      if (!worn || gear[worn.type][2] < bonus) manage(g, g.turn, 'equip:' + index);
    });
  }
  function bot(g,acts) {
    dressBot(g);
    if (g.phase!=='combat') return acts[0];
    if (power(g.heroes[g.turn])+g.boost>g.monster.strength) return 'fight';
    return acts.find(a=>a.startsWith('help:')) || (acts.includes('potion')?'potion':'flee');
  }
  const rules={create,available,play,bot,power,gear,inventoryActions,manage,view};
  if (typeof module==='object' && module.exports) module.exports=rules;
  else window.MunchkinRules=rules;
})();
