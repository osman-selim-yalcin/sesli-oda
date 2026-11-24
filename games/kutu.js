const { randomUUID } = require('node:crypto');
const engines = { catan: require('../public/catan-kurallar'), munchkin: require('../public/munchkin-kurallar') };

module.exports = function setup({ io, getRoom, rooms, BOT, postSystem }) {
  function send(room, key) {
    if (key === 'munchkin') {
      for (const [id, user] of room.users) {
        io.to(id).emit('kutu:state', { key, game: engines.munchkin.view(room[key], user.name) });
      }
    } else io.to(room.code).emit('kutu:state', { key, game: room[key] });
  }
  function advance(room, key, action) {
    const game = room[key];
    engines[key].play(game, action);
    game.revision++;
    send(room, key);
    if (game.done) postSystem(room, game.log);
    else if (game.players[game.turn] === BOT) setTimeout(() => {
      if (rooms.get(room.code) !== room || room[key] !== game || game.done || game.players[game.turn] !== BOT) return;
      const engine = engines[key];
      advance(room, key, engine.bot(game, engine.available(game)));
    }, 480).unref();
  }
  function finish(room, key, name) {
    const game = room[key];
    if (!game || game.done || !game.players.includes(name)) return;
    game.done = true;
    game.log = name+' ayrıldı. Maç sona erdi.';
    send(room, key);
    postSystem(room, game.log);
  }
  return {
    munchkinView: engines.munchkin.view,
    start(room, key, players) {
      room[key] = { ...engines[key].create(players), id: randomUUID(), revision: 0 };
      send(room, key);
      postSystem(room, (key === 'catan' ? 'Catan' : 'Munchkin')+' maçı başladı.');
    },
    left(room, name) { for (const key of Object.keys(engines)) finish(room, key, name); },
    bind(socket, code) {
      socket.on('kutu:action', input => {
        if (!code() || typeof input?.key !== 'string' || !Object.hasOwn(engines, input.key)) return;
        const room = getRoom(code()), game = room[input.key], name = room.users.get(socket.id)?.name;
        if (!game || game.done || game.id !== input.id || game.revision !== input.revision) return;
        if (input.action === 'leave') return finish(room, input.key, name);
        if (input.key === 'munchkin' && engines.munchkin.manage(game, game.players.indexOf(name), input.action)) {
          game.revision++;
          send(room, input.key);
          return;
        }
        if (game.players[game.turn] !== name || !engines[input.key].available(game).includes(input.action)) return;
        advance(room, input.key, input.action);
      });
    },
  };
};
