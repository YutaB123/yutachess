const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
  rooms.delete(roomId);
}

function scheduleTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.timeoutHandle) clearTimeout(room.timeoutHandle);

  const ms = room.chess.turn() === 'w' ? room.whiteTime : room.blackTime;
  room.timeoutHandle = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    const loser = r.chess.turn() === 'w' ? 'white' : 'black';
    io.to(roomId).emit('timeout', { loser });
    // Keep room alive for potential rematch
    r.status = 'gameover';
    r.rematch = { white: false, black: false };
    r.timeoutHandle = null;
  }, ms);
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ timeControl } = {}) => {
    const minutes   = timeControl?.minutes   ?? 10;
    const increment = timeControl?.increment ?? 0;
    const timeMs    = minutes * 60 * 1000;
    const roomId    = generateRoomId();

    rooms.set(roomId, {
      chess: new Chess(),
      white: socket.id,
      black: null,
      whiteTime: timeMs,
      blackTime: timeMs,
      increment,
      lastMoveTime: null,
      timeoutHandle: null,
      timeControl: { minutes, increment },
      status: 'waiting',
      rematch: null,
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.color  = 'white';
    socket.emit('room_created', { roomId });
    console.log(`Room ${roomId} created (${minutes}+${increment})`);
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.black) {
      socket.emit('join_error', { message: 'This game is already full.' });
      return;
    }

    room.black = socket.id;
    room.status = 'playing';
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.color  = 'black';
    room.lastMoveTime  = Date.now();

    const clockInfo = { timeControl: room.timeControl, whiteTime: room.whiteTime, blackTime: room.blackTime };
    io.to(room.white).emit('game_start', { color: 'white', ...clockInfo });
    socket.emit('game_start',            { color: 'black', ...clockInfo });

    scheduleTimeout(roomId);
    console.log(`Game started in room ${roomId}`);
  });

  socket.on('move', ({ from, to, promotion = 'q' }) => {
    const { roomId, color } = socket.data;
    if (!roomId || !color) return;

    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const turn = room.chess.turn();
    if ((turn === 'w' && color !== 'white') || (turn === 'b' && color !== 'black')) return;

    const elapsed = Date.now() - room.lastMoveTime;
    if (turn === 'w') {
      room.whiteTime = Math.max(0, room.whiteTime - elapsed) + room.increment * 1000;
    } else {
      room.blackTime = Math.max(0, room.blackTime - elapsed) + room.increment * 1000;
    }
    room.lastMoveTime = Date.now();

    const result = room.chess.move({ from, to, promotion });
    if (!result) { socket.emit('invalid_move'); return; }

    const fen     = room.chess.fen();
    const inCheck = room.chess.in_check();
    const times   = { whiteTime: room.whiteTime, blackTime: room.blackTime };
    let gameOver  = false, winner = null, drawReason = null;

    if (room.chess.game_over()) {
      gameOver = true;
      if (room.chess.in_checkmate())      winner     = color;
      else if (room.chess.in_stalemate()) drawReason = 'stalemate';
      else                                drawReason = 'draw';
    }

    const payload = { from, to, promotion, fen, inCheck, gameOver, winner, drawReason, times };
    socket.to(roomId).emit('move_made',   payload);
    socket.emit('move_confirmed', { fen, inCheck, gameOver, winner, drawReason, times });

    if (gameOver) {
      if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
      room.timeoutHandle = null;
      room.status  = 'gameover';
      room.rematch = { white: false, black: false };
    } else {
      scheduleTimeout(roomId);
    }
  });

  socket.on('request_rematch', () => {
    const { roomId, color } = socket.data;
    if (!roomId || !color) return;

    const room = rooms.get(roomId);
    if (!room || room.status !== 'gameover') return;

    room.rematch[color] = true;

    // Tell opponent this player is ready
    socket.to(roomId).emit('rematch_requested');

    if (room.rematch.white && room.rematch.black) {
      // Both ready — reset and restart with same time control
      room.chess = new Chess();
      const timeMs = room.timeControl.minutes * 60 * 1000;
      room.whiteTime    = timeMs;
      room.blackTime    = timeMs;
      room.lastMoveTime = Date.now();
      room.status       = 'playing';
      room.rematch      = null;

      const clockInfo = { timeControl: room.timeControl, whiteTime: room.whiteTime, blackTime: room.blackTime };
      io.to(room.white).emit('game_start', { color: 'white', ...clockInfo });
      io.to(room.black).emit('game_start', { color: 'black', ...clockInfo });

      scheduleTimeout(roomId);
      console.log(`Rematch started in room ${roomId}`);
    }
  });

  socket.on('resign', () => {
    const { roomId, color } = socket.data;
    if (!roomId || !color) return;
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
    room.timeoutHandle = null;
    room.status  = 'gameover';
    room.rematch = { white: false, black: false };

    io.to(roomId).emit('player_resigned', { resigner: color });
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.status === 'gameover') {
      socket.to(roomId).emit('rematch_declined', { message: "Opponent left — can't rematch." });
    } else {
      socket.to(roomId).emit('opponent_left');
    }
    deleteRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`yutachess running on http://localhost:${PORT}`));
