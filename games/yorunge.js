const rules = require('../public/yorunge-kurallar');
const { create, play, botMove } = rules;

function setup({ io, getRoom, postSystem, BOT }) {
  const send = room => io.to(room.code).emit('yorunge', room.yorunge);
  function advance(room, move) {
    const game = room.yorunge;
    play(game, move);
    send(room);
    if (game.done) postSystem(room, game.result);
    else if (game.players[game.turn] === BOT) {
      setImmediate(() => {
        if (room.yorunge === game && !game.done && room.bot && game.players[game.turn] === BOT) advance(room, botMove(game));
      });
    }
  }
  function left(room, name) {
    const g = room.yorunge;
    if (!g || g.done || !g.players.includes(name)) return;
    g.done = true;
    g.moves = [];
    g.result = `${name} çekildi. ${g.players.find(p => p !== name)} kazandı.`;
    send(room);
    postSystem(room, g.result);
  }
  return {
    start(room, by, players) {
      room.yorunge = create(players);
      postSystem(room, `${by} Yörünge Kuşatması maçını başlattı.`);
      send(room);
    },
    left,
    bind(socket, code) {
      socket.on('yorunge:move', (input) => {
        if (!code() || !input) return;
        const room = getRoom(code());
        const g = room.yorunge;
        if (!g || g.done || input.id !== g.id || input.revision !== g.revision || room.users.get(socket.id)?.name !== g.players[g.turn]) return;
        const move = g.moves.find(m => m.from === input.from && m.kind === input.kind && m.to === input.to);
        if (move) advance(room, move);
      });
      socket.on('yorunge:resign', id => {
        if (!code()) return;
        const room = getRoom(code());
        if (room.yorunge?.id === id) left(room, room.users.get(socket.id)?.name);
      });
    },
  };
}
module.exports = { setup, ...rules };
