'use strict';

const [ el_game, el_game_map, el_game_players, el_stats_winner, el_end_stats, el_end_close ] = [
  '.game', '.map', '.players', '.game-winner', '.end-stats', '.close-endscreen'
].map(sel => document.querySelector(sel));

const TICK_RATE = 50;
const OPCODE = {
  S: {
    GAME_INFO: 0,
    GAME_MAP: 1,
    GAME_PLAYER_DATA: 2,
    GAME_SELF_INFO: 3,
    GAME_WRONG_MOVE: 4,
    GAME_PAINT_CLEAR: 5
  },
  C: {
    KEYPRESS: 0
  }
};

const STATE = {
  OFFLINE: -2,
  DISCON: -1,
  IDLE: 0,
  PLAYING: 1,
  ENDED: 2
}

const dynStyles = document.createElement('style');
const dynColorStyles = document.createElement('style');
dynStyles.setAttribute('type', 'text/css');
dynColorStyles.setAttribute('type', 'text/css');
document.head.appendChild(dynStyles);
document.head.appendChild(dynColorStyles);

/* elem: {tag: 'tagName', children: [elem(s)...], any_html_elem_prop: 'value'} */
function mkHTMLStructure(data, base = null, replace = false) {
  const create = (tag, ns = null) => {
    if (ns) {
      return document.createElementNS(ns, tag);
    } else {
      return document.createElement(tag);
    }
  };

  var el = base || create(data.tag, data.NS);
  var childs = [];

  for (var child_data of (data.children || [])) {
    /* create all specified children and apend them */
    childs.push(mkHTMLStructure(child_data));
  }

  if (replace) {
    el.replaceChildren(...childs);
  } else {
    el.append(...childs);
  }

  delete data.tag;
  delete data.NS;
  delete data.children;

  for (var prop in data) {
    var path = prop.split('.');
    var target = () => el;
    while (path.length > 1) target = ((t, p) => () => t()[p])(target, path.shift());
    target()[path[0]] = data[prop];
  }

  return el;
}

/** jquery jjpaya edition */
function addfuncs(arr) {
	const bindEvt = (elm, evt, fn) => elm.addEventListener(evt, e => fn(e, elm));
	const bindEvtOnce = (elms, evt, fn) => {
		const fnref = e => {
			fn(e, e.currentTarget);
			
			// avoid leaks
			for (const el of elms) {
				el.removeEventListener(evt, fnref);
			}
		};
		
		for (const el of elms) {
			el.addEventListener(evt, fnref);
		}
	};
	
	var mkprom = initfn => new Promise(initfn);
	// bind fn to ev on all selected elems
	arr.on = (ev, fn) => (arr.forEach(elm => bindEvt(elm, ev, fn)), arr);
	arr.once = (ev, fn) => fn ? (bindEvtOnce(arr, ev, fn), arr) : mkprom(r => bindEvtOnce(arr, ev, r));
	arr.click = fn => fn ? arr.on('click', fn) : arr.once('click');
	arr.addClass = (...cl) => (arr.forEach(elm => elm.classList.add(...cl)), arr);
	arr.setClass = (...cl) => (arr.forEach(elm => elm.classList = cl.join(' ')), arr);
	arr.hasClass = cl => (arr.reduce((sum, elm) => sum + elm.classList.contains(cl), 0), arr);
	arr.delClass = (...cl) => (arr.forEach(elm => elm.classList.remove(...cl)), arr);
	arr.text = v => (arr.forEach(elm => elm.innerText = v), arr);
	arr.html = v => (arr.forEach(elm => elm.innerHTML = v), arr);

	return arr;
}

const $$ = sel => addfuncs(document.querySelectorAll(sel));

/* css styling "constants" only */
var colorClasses = [];
var activeColorClasses = [];

var ws = null;
var map = [];
var paintMap = [];
var tickTimer = -1;
var centerCameraFrameRequest = -1;
var oldGameState = STATE.DISCON;
var gameState = STATE.DISCON;
var stateTime = null;
var currentlyDisplayedGameTime = 0;
var mapWidth = 30;
var playersPerRound = 10;
var mapReady = false;
var gameId = null;
var posSynced = false; /* for movement prediction */
var selfPlayer = null;
var selfPlayerId = null;
var myCell = null;
var numPlayers = 0;
var players = {};
var endGamePlayers = null;
var playerColors = null;

document.addEventListener('keydown', e => {
  var key = e.code;
  if (!key.startsWith('Key')) {
    return;
  }

  e.preventDefault();
  movePlayer(key.slice(3));
});

window.addEventListener('resize', e => {
  if (myCell) {
    centerCamera(myCell);
  }
});

el_end_close.addEventListener('click', e => {
  el_end_stats.classList.add('closed');
});

function setGameState(state) {
  const htmlStates = ['offline', 'discon', 'idle', 'playing', 'ended'];
  var textState = htmlStates[state + 2];
  console.log('New game state:', textState);
  document.body.setAttribute('game-state', textState);
  oldGameState = gameState;
  gameState = state;
  
  if (textState == 'ended') {
    if (gameState !== oldGameState) {
      endGamePlayers = players;
      updateScoreboard();
    }

    el_end_stats.classList.remove('closed');
  }
}

function updateStatusTexts() {
  $$('.num-players').text(numPlayers);
  $$('.pl-per-round').text(playersPerRound);
  $$('.my-color').setClass('my-color', 'pl-' + selfPlayerId);
}

function setGameTimer(seconds) {
  seconds = Math.floor(seconds);

  if (currentlyDisplayedGameTime == seconds) {
    return; /* Already displaying this time, don't update the DOM */
  }

  currentlyDisplayedGameTime = seconds;
  var mins = Math.floor(seconds / 60);
  seconds %= 60;

  var text = mins + ':' + seconds.toString().padStart(2, '0');
  $$('.game-timer').text(text);
}

function movePlayer(key) {
  var buf = new Uint8Array(2);
  buf[0] = OPCODE.C.KEYPRESS;
  buf[1] = key.charCodeAt(0);
  ws.send(buf.buffer);

  if (selfPlayer.frozen || !posSynced) {
    return;
  }

  const getCell = (x, y) => map[x + y * mapWidth];
  const getPlayerAt = (x, y) => {
    for (var id in players) {
      var p = players[id];
      if (p.x == x && p.y == y) {
        return p;
      }
    }

    return null;
  };
  
  /* simple move prediction to hide lag */
  outer_loop:
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      if (ox == 0 && oy == 0) { continue; }
      if (getCell(selfPlayer.x + ox, selfPlayer.y + oy) == key[0]) {
        if (getPlayerAt(selfPlayer.x + ox, selfPlayer.y + oy)) {
          /* Unpredictable movement when colliding with players, don't even try */
          break outer_loop;
        }

        selfPlayer.x += ox;
        selfPlayer.y += oy;
        posSynced = false;
        renderPlayers();
        break outer_loop;
      }
    }
  }
}

function centerCamera(me) {
  if (!me) { return; }

  function center() {
    centerCameraFrameRequest = -1;
    if (!me) { return; }
    var pos = {x: me.offsetLeft, y: me.offsetTop, width: me.offsetWidth, height: me.offsetHeight};
    var x = -(pos.x + pos.width / 2) + window.innerWidth / 2;
    var y = -(pos.y + pos.height / 2) + window.innerHeight / 2;
    el_game_map.style.transform = `translate(${x}px, ${y}px)`;
  }

  if (centerCameraFrameRequest != -1) {
    window.cancelAnimationFrame(centerCameraFrameRequest);
  }
  
  centerCameraFrameRequest = window.requestAnimationFrame(center);
}

async function loadKbLayout() {
  var layout = 'qwertyuiopasdfghjklzxcvbnm'.split('').map(c => ['Key'+c.toUpperCase(), c]);
  var cssText = '';

  if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
    try {
      layout = await navigator.keyboard.getLayoutMap();
    } catch(e) { }
  }

  for (const [k, v] of layout) {
    cssText += `
    .kb-${k.toLowerCase()}::before {
      content: "${v}";
    }
    `;
  }

  dynStyles.innerHTML = cssText;
}

function initPlayerColors() {
  var cssText = '';

  for (var i = 0; i < playerColors.length; i++) {
    cssText += `
    .map > .map-cell.apl-${i + 1}, .game > .map > div.map-cell.pl-${i + 1}, .pl-${i + 1} {
      background-color: ${playerColors[i]};
    }
    `;
  }

  dynColorStyles.innerHTML = cssText;
}

function initStylingConstants() {
  colorClasses = Array.from({length: playersPerRound}, (a, i) => 'pl-' + (i+1));
  activeColorClasses = Array.from({length: playersPerRound}, (a, i) => 'apl-' + (i+1));
}

function updateScoreboard() {
  var elm_scores = $$('.scores')[0];
  var scoreRows = [];

  const playerPaintPoints = id => paintMap.reduce((sum, cell) => sum + (cell === id ? 10 : 0), 0);

  for (var id in (gameState == STATE.ENDED ? endGamePlayers : players)) {
    var sum = playerPaintPoints(+id);
    var total = players[id].points + sum;
    var pname = 'Player ' + id + ((+id) === selfPlayerId ? ' (You)' : '');
    scoreRows.push({
      tag: 'div',
      children: [
        {tag: 'span', innerText: pname},
        {tag: 'span', innerText: total}
      ],
      totalPoints: total,
      playerName: pname
    });
  }

  scoreRows = scoreRows.sort((a, b) => b.totalPoints - a.totalPoints);

  if (scoreRows[0]) {
    var winner = scoreRows[0];
    mkHTMLStructure({children: [{
      tag: 'b',
      innerText: winner.playerName
    }, {
      tag: 'span',
      innerText: 'won the game with ' + winner.totalPoints + ' points!'
    }]}, el_stats_winner, true);
  }

  mkHTMLStructure({children: scoreRows}, elm_scores, true);
}

function renderMap() {
  var mapStruct;
  
  const getColorPlayer = i => paintMap[i] > 0 ? 'pl-' + paintMap[i] : '';
  /** Convert map array to element array to pass to mkHTMLStructure */
  mapStruct = map.map((char, i) => ({
    tag: 'div',
    className: 'map-cell kb-key' + char.toLowerCase() + ' ' + getColorPlayer(i)
  }));

  mkHTMLStructure({children: mapStruct}, el_game_map, true);
  renderPlayers();
}

function applyPaintUpdates(updates) {
  for (var i = 0; i < updates.length; i++) {
    var upd = updates[i];
    paintMap[upd.x + upd.y * mapWidth] = upd.clr;
    var cell = el_game_map.children[upd.x + upd.y * mapWidth];
    cell.classList.remove(...colorClasses);
    if (upd.clr > 0) {
      cell.classList.add('pl-' + upd.clr);
    }
  }
}

function renderPlayers() {
  $$('.map-cell.cell-active, .map-cell.cell-active-me')
    .delClass('cell-active', 'cell-active-me', 'frozen', ...activeColorClasses);

  var me = null;

  for (var id in players) {
    var p = players[id];
    var cell = el_game_map.children[p.x + p.y * mapWidth];
    var classes = ['cell-active', 'apl-' + id];

    if (p.frozen) {
      classes.push('frozen');
    }

    if (id == selfPlayerId) {
      classes.push('cell-active-me');
      me = cell;
    }

    cell.classList.add(...classes);
  }

  myCell = me;

  centerCamera(me);
}

function startTicking() {
  stopTicking();
  tickTimer = setInterval(tick, TICK_RATE);
}

function stopTicking() {
  if (tickTimer >= 0) {
    clearInterval(tickTimer);
    tickTimer = -1;
  }
}

function tick() {
  if (!stateTime) {
    return;
  }
  
  var now = Date.now();
  var time = new Date(stateTime).getTime();
  var deltaSec = (now - time) / 1000;

  switch (gameState) {
    case STATE.IDLE:
      var timeLeft = Math.max(31 - deltaSec, 0);
      setGameTimer(numPlayers > 1 ? timeLeft : 30);
      break;

    case STATE.PLAYING:
      var timeLeft = Math.max(Math.min(60 * ~~(numPlayers / 2), 300) - deltaSec, 0);
      setGameTimer(timeLeft);
      break;

    case STATE.ENDED:
      var timeLeft = Math.max(31 - deltaSec, 0);
      setGameTimer(timeLeft);
      break;
  }

}

function readPacket(data) {
  //console.log([...new Uint8Array(data.data)]);

  var buf = data.data;
  var dv = new DataView(buf);
  switch (dv.getUint8(0)) {
    case OPCODE.S.GAME_INFO:
      numPlayers = dv.getUint8(1);
      var newGameState = dv.getUint16(2, true);
      gameId = dv.getUint32(4, true);
      mapWidth = dv.getUint32(8, true);
      playersPerRound = dv.getUint32(12, true);
      stateTime = Number(dv.getBigInt64(16, true));
      playerColors = [];
      for (var i = 24; i < buf.byteLength; i += 4) {
        playerColors.push('#'+dv.getUint32(i, false).toString(16).padStart(8, '0'));
      }
      console.log("Got game id:", gameId, ",", numPlayers, "players,", mapWidth, "mapWidth, colors:", playerColors);
      initPlayerColors();
      initStylingConstants();
      setGameState(newGameState);
      updateStatusTexts();
      break;

    case OPCODE.S.GAME_MAP:
      var offs = 1;
      var halfSize = (buf.byteLength - 1) / 2;
      map = [...new Uint8Array(buf, offs, halfSize)].map(n => String.fromCharCode(n));
      offs += halfSize;
      paintMap = new Uint8Array(buf, offs, halfSize);
      console.log("Got map");
      mapReady = renderMap();
      break;

    case OPCODE.S.GAME_PLAYER_DATA:
      var newPlayers = {};
      var paintUpdates = [];
      /** every player element is 17 bytes in length (id, x, y, points, frozen) */
      var offs = 1;
      var numPlayerUpdates = dv.getUint8(offs++);
      for (var i = 0; i < numPlayerUpdates; i++) {
        var pid = dv.getUint32(offs + i * 17, true);
        var points = dv.getInt32(offs + i * 17 + 12, true);
        newPlayers[pid] = {
          x: dv.getInt32(offs + i * 17 + 4, true),
          y: dv.getInt32(offs + i * 17 + 8, true),
          lastPoints: (players[pid] || {points}).points,
          points: points,
          frozen: dv.getUint8(offs + i * 17 + 16)
        };
      }

      offs += numPlayerUpdates * 17;
      var numPaintUpdates = dv.getUint16(offs, true);
      offs += 2;
      for (var i = 0; i < numPaintUpdates; i++) {
        paintUpdates.push({
          x: dv.getInt32(offs + i * 9, true),
          y: dv.getInt32(offs + i * 9 + 4, true),
          clr: dv.getUint8(offs + i * 9 + 8)
        });
      }

      players = newPlayers;
      selfPlayer = players[selfPlayerId];
      posSynced = true;
      renderPlayers();
      applyPaintUpdates(paintUpdates);
      updateScoreboard();
      break;

    case OPCODE.S.GAME_SELF_INFO:
      selfPlayerId = dv.getUint32(1, true);
      console.log('My ID:', selfPlayerId);
      break;

    case OPCODE.S.GAME_WRONG_MOVE:
      break;
      
    case OPCODE.S.GAME_PAINT_CLEAR:
      console.log('Paint map clear');
      for (var i = 0; i < paintMap.length; i++) {
        paintMap[i] = 0;
      }

      renderMap();
      updateScoreboard();
      break;
  }
}

async function init() {
  setGameState(STATE.OFFLINE);
  await loadKbLayout();
  ws = new WebSocket("ws://" + location.hostname + ":9001");
  ws.binaryType = "arraybuffer";
  ws.onmessage = readPacket;
  ws.onopen = () => {
    console.log('Connected!');
    startTicking();
  };

  ws.onclose = () => {
    stopTicking();
    console.log('Disconnected.');
    setGameState(STATE.DISCON);
    setTimeout(init, 4000);
  }
}

init();
