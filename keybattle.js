'use strict';

const [ el_game, el_game_map, el_game_players ] = [
  '.game', '.map', '.players'
].map(sel => document.querySelector(sel));

const OPCODE = {
  S: {
    GAME_INFO: 0,
    GAME_MAP: 1,
    GAME_PLAYER_DATA: 2,
    GAME_SELF_INFO: 3,
    GAME_WRONG_MOVE: 4
  },
  C: {
    KEYPRESS: 0
  }
};

var ws = null;
var map = [];
var mapWidth = 30;
var gameId = null;
var selfPlayer = null;
var selfPlayerId = null;
var myCell = null;
var numPlayers = 0;
var players = {};

function waitFrames(n, cb) {
	window.requestAnimationFrame(() => {
		return n > 0 ? waitFrames(--n, cb) : cb();
	})
}

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

document.addEventListener('keydown', e => {
  var key = e.code;
  if (!key.startsWith('Key')) {
    return;
  }

  movePlayer(key.slice(3));
});

window.addEventListener('resize', e => {
  if (myCell) {
    centerCamera(myCell);
  }
});

function movePlayer(key) {
  console.log(key);
  var buf = new Uint8Array(2);
  buf[0] = OPCODE.C.KEYPRESS;
  buf[1] = key.charCodeAt(0);
  ws.send(buf.buffer);
}

function centerCamera(me) {
  if (!me) { return; }
  var pos = {x: me.offsetLeft, y: me.offsetTop, width: me.offsetWidth, height: me.offsetHeight};
  var x = -(pos.x + pos.width / 2) + window.innerWidth / 2;
  var y = -(pos.y + pos.height / 2) + window.innerHeight / 2;
  el_game_map.style.transform = `translate(${x}px, ${y}px)`;
}

function renderMap() {
  var mapStruct;

  /** Convert map array to element array to pass to mkHTMLStructure */
  mapStruct = map.map(char => ({
    tag: 'div',
    className: 'map-cell',
    innerText: char
  }));

  console.log(mapStruct);
  mkHTMLStructure({children: mapStruct}, el_game_map);
}

function renderPlayers() {
  var playerElems = [];

  var activeElms = document.querySelectorAll('.map-cell.cell-active, .map-cell.cell-active-me');
  for (var i = 0; i < activeElms.length; i++) {
    activeElms[i].classList.remove('cell-active');
    activeElms[i].classList.remove('cell-active-me');
  }

  var me = null;

  for (var id in players) {
    var p = players[id];
    var cell = el_game_map.children[p.x + p.y * mapWidth];
    cell.classList.add('cell-active');
    if (id == selfPlayerId) {
      cell.classList.add('cell-active-me');
      me = cell;
    }
  }

  myCell = me;

  //waitFrames(60, (me => () => centerCamera(me))(me));
  centerCamera(me);
  //mkHTMLStructure({children: playerElems}, el_game_players)
}

function readPacket(data) {
  console.log([...new Uint8Array(data.data)]);

  var dv = new DataView(data.data);
  switch (dv.getUint8(0)) {
    case OPCODE.S.GAME_INFO:
      gameId = dv.getUint32(1, true);
      mapWidth = dv.getUint32(5, true);
      numPlayers = dv.getUint8(9);
      console.log("Got game id:", gameId, ",", numPlayers, "players,", mapWidth, "mapWidth");
      break;

    case OPCODE.S.GAME_MAP:
      map = [...new Uint8Array(data.data, 1)].map(n => String.fromCharCode(n));
      console.log("Got map");
      renderMap();
      break;

    case OPCODE.S.GAME_PLAYER_DATA:
      var recvPlayerIds = [];
      /** every player element is 12 bytes in length (id, x, y) */
      for (var i = 0; i < (dv.byteLength - 1) / 12; i++) {
        var pid = dv.getUint32(1 + i * 12, true);
        recvPlayerIds.push(pid);
        players[pid] = {
          x: dv.getInt32(1 + i * 12 + 4, true),
          y: dv.getInt32(1 + i * 12 + 8, true)
        };
      }
      var toDelete = Object.keys(players).filter(id => !recvPlayerIds.includes(+id));
      for (var id of toDelete) {
        /** Delete player IDs that were not updated, they left the game */
        delete players[id];
      }

      selfPlayer = players[selfPlayerId];
      renderPlayers();
      break;

    case OPCODE.S.GAME_SELF_INFO:
      selfPlayerId = dv.getUint32(1, true);
      console.log('My ID:', selfPlayerId);
      break;

    case OPCODE.S.GAME_WRONG_MOVE:
      break;
  }
}

function init() {
  ws = new WebSocket("ws://localhost:9001");
  ws.binaryType = "arraybuffer";
  ws.onmessage = readPacket;
}

init();
