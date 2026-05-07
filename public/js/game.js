const socket = io({ transports: ['websocket'] });

let game        = null;
let board       = null;
let myColor     = null;
let myRoomId    = null;
let selectedTC  = null;

// Click-to-move state
let selectedSquare    = null;
let clickListenerAdded = false;

// Move history
let moveHistory = [];

// Clock state
let clockInterval = null;
let whiteClock    = 0;
let blackClock    = 0;

// ─── Piece theme ─────────────────────────────────────
const PIECE_SOLID = {
  wK: '♚', wQ: '♛', wR: '♜', wB: '♝', wN: '♞', wP: '♟',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

function PIECE_THEME(piece) {
  const isWhite = piece[0] === 'w';
  const fill    = isWhite ? '#ffffff' : '#1a1a1a';
  const stroke  = isWhite ? '#222222' : '#bbbbbb';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">
    <text x="22.5" y="36" font-size="32" font-family="serif"
      text-anchor="middle" fill="${fill}"
      stroke="${stroke}" stroke-width="1.2" paint-order="stroke">${PIECE_SOLID[piece]}</text>
  </svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ─── Helpers ─────────────────────────────────────────
const $ = id => document.getElementById(id);
const SCREENS = ['setup', 'loading', 'waiting', 'playing', 'error'];

function show(name) {
  SCREENS.forEach(s => {
    const el = $(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function tcLabel({ minutes, increment }) {
  const cat = minutes < 3 ? 'Bullet' : minutes < 10 ? 'Blitz' : 'Rapid';
  return `${cat} · ${minutes}+${increment}`;
}

// ─── Boot ────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const roomParam = params.get('room');

if (roomParam) {
  myRoomId = roomParam.toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('loading-msg').textContent = 'Joining game…';
  show('loading');
  socket.on('connect', () => socket.emit('join_room', { roomId: myRoomId }));
} else {
  show('setup');
}

// ─── Time control picker ─────────────────────────────
document.querySelectorAll('.tc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tc-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedTC = {
      minutes:   parseInt(btn.dataset.minutes, 10),
      increment: parseInt(btn.dataset.increment, 10),
    };
    $('create-btn').disabled = false;
  });
});

$('create-btn').addEventListener('click', () => {
  if (!selectedTC) return;
  show('loading');
  $('loading-msg').textContent = 'Creating game…';
  const doCreate = () => socket.emit('create_room', { timeControl: selectedTC });
  if (socket.connected) doCreate();
  else socket.once('connect', doCreate);
});

// ─── Socket events ───────────────────────────────────
socket.on('room_created', ({ roomId }) => {
  myRoomId = roomId;
  $('room-code-display').textContent = roomId;
  $('share-link').value = `${location.origin}/game.html?room=${roomId}`;
  $('waiting-tc').textContent = selectedTC ? tcLabel(selectedTC) : '';
  show('waiting');
});

socket.on('game_start', ({ color, timeControl, whiteTime, blackTime }) => {
  myColor    = color;
  whiteClock = whiteTime;
  blackClock = blackTime;
  moveHistory = [];
  $('game-overlay').classList.add('hidden');
  show('playing');
  initBoard(timeControl);
});

socket.on('move_made', ({ from, to, promotion, fen, inCheck, gameOver, winner, drawReason, times }) => {
  const move = game.move({ from, to, promotion });
  board.position(fen, false);
  clearHighlights();
  if (move) addMoveToHistory(move);
  syncClocks(times);
  setStatus({ inCheck, gameOver, winner, drawReason });
});

socket.on('move_confirmed', ({ fen, inCheck, gameOver, winner, drawReason, times }) => {
  syncClocks(times);
  setStatus({ inCheck, gameOver, winner, drawReason });
});

socket.on('invalid_move', () => {
  board.position(game.fen(), false);
  setStatus({});
});

socket.on('timeout', ({ loser }) => {
  stopClock();
  const iLost = loser === myColor;
  showOverlay(
    iLost ? '⏱ You ran out of time.' : '⏱ Opponent ran out of time!',
    iLost ? 'lose' : 'win'
  );
});

socket.on('rematch_requested', () => {
  const btns = $('overlay-btns');
  if (btns.dataset.state !== 'waiting') {
    const hint = btns.querySelector('.rematch-hint');
    if (!hint) {
      const p = document.createElement('p');
      p.className = 'rematch-hint';
      p.textContent = 'Opponent wants a rematch!';
      btns.prepend(p);
    }
  }
});

socket.on('rematch_declined', ({ message }) => {
  stopClock();
  $('overlay-icon').textContent = '👋';
  $('overlay-msg').textContent  = message || "Opponent didn't want a rematch.";
  setOverlayButtons('home-only');
});

socket.on('join_error', ({ message }) => {
  $('error-msg').textContent = message;
  show('error');
});

socket.on('player_resigned', ({ resigner }) => {
  stopClock();
  clearHighlights();
  if (resigner === myColor) {
    showOverlay('You resigned.', 'lose');
  } else {
    showOverlay('Opponent resigned. You win!', 'win');
  }
  $('resign-btn').classList.add('hidden');
});

socket.on('opponent_left', () => {
  stopClock();
  $('overlay-icon').textContent = '🔌';
  $('overlay-msg').textContent  = 'Opponent disconnected.';
  setOverlayButtons('home-only');
  $('game-overlay').classList.remove('hidden');
});

// ─── Board init ──────────────────────────────────────
function initBoard(timeControl) {
  game           = new Chess();
  selectedSquare = null;
  moveHistory    = [];
  renderMoveHistory();

  board = Chessboard('board', {
    draggable:    false,
    position:     'start',
    orientation:  myColor,
    pieceTheme:   PIECE_THEME,
  });

  if (!clickListenerAdded) {
    $('board-container').addEventListener('click', handleBoardClick);
    clickListenerAdded = true;
  }

  const isWhite = myColor === 'white';
  $('color-label').innerHTML    = `<span class="player-dot ${myColor}"></span> You`;
  $('opponent-label').innerHTML = `<span class="player-dot ${isWhite ? 'black' : 'white'}"></span> Opponent`;
  $('room-label').textContent   = `Room: ${myRoomId}`;

  $('resign-btn').textContent = 'Resign';
  $('resign-btn').classList.remove('confirming', 'hidden');
  resignPending = false;

  window.addEventListener('resize', () => board.resize());
  startClock();
  setStatus({});
}

// ─── Click-to-move ───────────────────────────────────
function handleBoardClick(e) {
  const squareEl = e.target.closest('[data-square]');
  if (!squareEl) return;
  onSquareClick(squareEl.getAttribute('data-square'));
}

function onSquareClick(square) {
  if (!game || game.game_over()) return;

  const myTurn = (myColor === 'white' && game.turn() === 'w') ||
                 (myColor === 'black' && game.turn() === 'b');
  if (!myTurn) return;

  if (selectedSquare) {
    // Clicking same square deselects
    if (selectedSquare === square) {
      clearHighlights();
      selectedSquare = null;
      return;
    }

    // Try the move
    const move = game.move({ from: selectedSquare, to: square, promotion: 'q' });
    if (move) {
      clearHighlights();
      selectedSquare = null;
      board.position(game.fen(), false);
      socket.emit('move', { from: move.from, to: move.to, promotion: 'q' });
      addMoveToHistory(move);

      if (game.game_over()) {
        let winner = null, drawReason = null;
        if (game.in_checkmate())      winner     = myColor;
        else if (game.in_stalemate()) drawReason = 'stalemate';
        else                          drawReason = 'draw';
        setStatus({ gameOver: true, winner, drawReason });
      } else {
        setStatus({ inCheck: game.in_check() });
      }
      return;
    }

    // Reselect another own piece
    const piece = game.get(square);
    const mine  = myColor === 'white' ? 'w' : 'b';
    if (piece && piece.color === mine) {
      clearHighlights();
      selectSquare(square);
    } else {
      clearHighlights();
      selectedSquare = null;
    }
  } else {
    const piece = game.get(square);
    const mine  = myColor === 'white' ? 'w' : 'b';
    if (!piece || piece.color !== mine) return;
    selectSquare(square);
  }
}

function selectSquare(square) {
  selectedSquare = square;
  highlightSquare(square, 'highlight-selected');
  game.moves({ square, verbose: true }).forEach(m => {
    highlightSquare(m.to, game.get(m.to) ? 'highlight-capture' : 'highlight-move');
  });
}

function clearHighlights() {
  document.querySelectorAll('.highlight-selected, .highlight-move, .highlight-capture')
    .forEach(el => el.classList.remove('highlight-selected', 'highlight-move', 'highlight-capture'));
}

function highlightSquare(square, cls) {
  const el = document.querySelector(`[data-square="${square}"]`);
  if (el) el.classList.add(cls);
}

// ─── Move history ────────────────────────────────────
function addMoveToHistory(move) {
  moveHistory.push(move);
  renderMoveHistory();
}

function renderMoveHistory() {
  const list = $('move-list');
  if (!list) return;
  list.innerHTML = '';

  for (let i = 0; i < moveHistory.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'move-row';

    const num = document.createElement('span');
    num.className   = 'move-num';
    num.textContent = `${Math.floor(i / 2) + 1}.`;

    const white = document.createElement('span');
    white.className   = 'move-san';
    white.textContent = moveHistory[i].san;

    row.appendChild(num);
    row.appendChild(white);

    if (moveHistory[i + 1]) {
      const black = document.createElement('span');
      black.className   = 'move-san';
      black.textContent = moveHistory[i + 1].san;
      row.appendChild(black);
    }

    list.appendChild(row);
  }

  list.scrollTop = list.scrollHeight;
}

// ─── Clock ───────────────────────────────────────────
function startClock() {
  stopClock();
  renderClocks();
  clockInterval = setInterval(() => {
    if (!game || game.game_over()) return;
    if (game.turn() === 'w') whiteClock = Math.max(0, whiteClock - 100);
    else                      blackClock = Math.max(0, blackClock - 100);
    renderClocks();
  }, 100);
}

function stopClock() {
  clearInterval(clockInterval);
  clockInterval = null;
}

function syncClocks({ whiteTime, blackTime }) {
  whiteClock = whiteTime;
  blackClock = blackTime;
  renderClocks();
}

function renderClocks() {
  const yourTime = myColor === 'white' ? whiteClock : blackClock;
  const oppTime  = myColor === 'white' ? blackClock : whiteClock;
  const myTurn   = (myColor === 'white' && game?.turn() === 'w') ||
                   (myColor === 'black' && game?.turn() === 'b');
  updateClock($('your-clock'),     yourTime,  myTurn);
  updateClock($('opponent-clock'), oppTime,  !myTurn);
}

function updateClock(el, ms, active) {
  el.textContent = formatTime(ms);
  el.classList.toggle('clock-active',    active);
  el.classList.toggle('clock-low',       ms < 30000 && ms > 0);
  el.classList.toggle('clock-critical',  ms < 10000 && ms > 0);
}

// ─── Status display ──────────────────────────────────
function setStatus({ inCheck, gameOver, winner, drawReason } = {}) {
  const card = $('status-card');
  const text = $('status-text');
  const dot  = $('turn-dot');

  if (gameOver) {
    stopClock();
    $('resign-btn').classList.add('hidden');
    card.className = 'status-card gameover';
    dot.className  = 'turn-dot';
    if (winner) {
      const iWon = winner === myColor;
      text.textContent = iWon ? 'You win!' : 'You lose.';
      showOverlay(iWon ? '🏆 You win!' : '😔 You lose.', iWon ? 'win' : 'lose');
    } else {
      const label = drawReason === 'stalemate' ? 'Stalemate' : 'Draw';
      text.textContent = label;
      showOverlay(`🤝 ${label} — it's a draw.`, 'draw');
    }
    return;
  }

  const myTurn = (myColor === 'white' && game?.turn() === 'w') ||
                 (myColor === 'black' && game?.turn() === 'b');
  dot.className = `turn-dot ${game?.turn() === 'w' ? 'white' : 'black'}`;

  if (inCheck) {
    card.className   = 'status-card check';
    text.textContent = '⚠ Check!';
  } else if (myTurn) {
    card.className   = 'status-card your-turn';
    text.textContent = 'Your turn';
  } else {
    card.className   = 'status-card';
    text.textContent = "Opponent's turn";
  }
}

function showOverlay(message, type) {
  const icons = { win: '🏆', lose: '😔', draw: '🤝', disconnect: '🔌' };
  $('overlay-icon').textContent = icons[type] ?? '♟';
  $('overlay-msg').textContent  = message;
  setOverlayButtons('default');
  $('game-overlay').classList.remove('hidden');
}

function setOverlayButtons(mode) {
  const btns = $('overlay-btns');
  btns.dataset.state = mode;

  if (mode === 'default') {
    btns.innerHTML = `
      <button class="btn btn-primary" id="overlay-play-again">Play Again</button>
      <a href="/" class="btn btn-ghost">Home</a>
    `;
    $('overlay-play-again').addEventListener('click', requestRematch);
  } else if (mode === 'waiting') {
    btns.innerHTML = `
      <div class="rematch-waiting">
        <div class="spinner-small"></div>
        <span>Waiting for opponent...</span>
      </div>
      <a href="/" class="btn btn-ghost">Cancel</a>
    `;
  } else if (mode === 'home-only') {
    btns.innerHTML = `<a href="/" class="btn btn-primary">Home</a>`;
  }
}

function requestRematch() {
  socket.emit('request_rematch');
  setOverlayButtons('waiting');
}

// ─── Button handlers ─────────────────────────────────
// ─── Resign button ───────────────────────────────────
let resignPending = false;
let resignTimer   = null;

$('resign-btn').addEventListener('click', () => {
  if (!resignPending) {
    resignPending = true;
    $('resign-btn').textContent = 'Confirm Resign?';
    $('resign-btn').classList.add('confirming');
    resignTimer = setTimeout(() => {
      resignPending = false;
      $('resign-btn').textContent = 'Resign';
      $('resign-btn').classList.remove('confirming');
    }, 3000);
  } else {
    clearTimeout(resignTimer);
    socket.emit('resign');
    $('resign-btn').classList.add('hidden');
  }
});

$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText($('share-link').value).then(() => {
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => ($('copy-btn').textContent = 'Copy'), 2000);
  });
});

$('new-game-btn').addEventListener('click', () => (location.href = '/game.html'));
