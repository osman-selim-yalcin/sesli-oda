'use strict';

(() => {
  const monsters = ['Vergi Ejderi','Homurdanan Sandık','Paslı Golem','Yankı Cini','Uykusuz Muhafız','Çorap Hırsızı','Kayıp Merdiven'];
  const gear = [['Çaydanlık Miğfer',0,1],['Pusula Tacı',0,3],['Yamalı Zırh',1,2],['Ayna Pelerini',1,4],['Tahta Kaşık',2,2],['Çınlayan Topuz',2,4]];
  const pick = list => list[Math.floor(Math.random()*list.length)];
  const die = () => 1+Math.floor(Math.random()*6);
  const power = h => h.level+h.gear.reduce((n,i)=>n+(gear[i]?.[2]||0),0);
  function create(players) {
    return {players, turn:0, phase:'door', heroes:players.map(()=>({ level:1, gear:[-1,-1,-1], potions:1 })),
      monster:null, boost:0, done:false, log:'Zindanın ilk kapısı önündesin.'};
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
    const id=pick(gear.map((_,i)=>i)), [name,slot,value]=gear[id];
    if ((gear[h.gear[slot]]?.[2]||0)<value) { h.gear[slot]=id; return name+' kuşanıldı.'; }
    h.potions++;
    return name+' bir iksirle takas edildi.';
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
  function bot(g,acts) {
    if (g.phase!=='combat') return acts[0];
    if (power(g.heroes[g.turn])+g.boost>g.monster.strength) return 'fight';
    return acts.find(a=>a.startsWith('help:')) || (acts.includes('potion')?'potion':'flee');
  }
  const rules={create,available,play,bot,power,gear};
  if (typeof module==='object' && module.exports) module.exports=rules;
  else window.MunchkinRules=rules;
})();
