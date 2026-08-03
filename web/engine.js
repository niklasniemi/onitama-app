/* ==========================================================================
   Onitama — rules engine
   Ported from onitamalib/ (cards.rs, board.rs). Shared verbatim by the browser
   and by the Socket.io server, so the two can never disagree about the rules:
   the server validates every move with exactly the code the client used.

   Loads as a plain <script> (sets window.Onitama) or as a CommonJS module
   (require("./engine.js")). No dependencies either way.
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Onitama = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((rand ? rand() : Math.random()) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/* ==========================================================================
   1. Cards — ported from onitamalib/src/cards.rs (index order preserved).
      Move deltas are in Red's frame: y = -1 is one step forward.
   ========================================================================== */

const DIR = { B: "中", L: "左", R: "右" };

const CARDS = [
  // --- Base set (0–15) ---
  { en: "Tiger",    fi: "Tiikeri",         k: "虎",   d: "B", m: [[0,-2],[0,1]] },
  { en: "Dragon",   fi: "Lohikäärme",      k: "龍",   d: "B", m: [[-2,-1],[-1,1],[2,-1],[1,1]] },
  { en: "Frog",     fi: "Sammakko",        k: "蛙",   d: "L", m: [[-2,0],[-1,-1],[1,1]] },
  { en: "Rabbit",   fi: "Jänis",           k: "兎",   d: "R", m: [[1,-1],[2,0],[-1,1]] },
  { en: "Crab",     fi: "Rapu",            k: "蟹",   d: "B", m: [[0,-1],[-2,0],[2,0]] },
  { en: "Elephant", fi: "Elefantti",       k: "象",   d: "B", m: [[1,0],[-1,-1],[1,-1],[-1,0]] },
  { en: "Goose",    fi: "Hanhi",           k: "鵞",   d: "L", m: [[-1,0],[-1,-1],[1,0],[1,1]] },
  { en: "Rooster",  fi: "Kukko",           k: "鶏",   d: "R", m: [[1,0],[1,-1],[-1,0],[-1,1]] },
  { en: "Monkey",   fi: "Apina",           k: "猿",   d: "B", m: [[-1,-1],[1,-1],[-1,1],[1,1]] },
  { en: "Mantis",   fi: "Sirkka",          k: "蟷",   d: "B", m: [[-1,-1],[1,-1],[0,1]] },
  { en: "Horse",    fi: "Hevonen",         k: "馬",   d: "L", m: [[0,-1],[-1,0],[0,1]] },
  { en: "Ox",       fi: "Härkä",           k: "牛",   d: "R", m: [[0,-1],[1,0],[0,1]] },
  { en: "Crane",    fi: "Kurki",           k: "鶴",   d: "B", m: [[0,-1],[1,1],[-1,1]] },
  { en: "Boar",     fi: "Villisika",       k: "猪",   d: "B", m: [[0,-1],[1,0],[-1,0]] },
  { en: "Eel",      fi: "Ankerias",        k: "鰻",   d: "L", m: [[1,0],[-1,-1],[-1,1]] },
  { en: "Cobra",    fi: "Kobra",           k: "蛇",   d: "R", m: [[-1,0],[1,-1],[1,1]] },
  // --- Sensei's Path (16–31) ---
  { en: "Fox",      fi: "Kettu",           k: "狐",   d: "R", m: [[1,-1],[1,0],[1,1]] },
  { en: "Dog",      fi: "Koira",           k: "犬",   d: "L", m: [[-1,-1],[-1,0],[-1,1]] },
  { en: "Giraffe",  fi: "Kirahvi",         k: "鹿",   d: "B", m: [[-2,-1],[2,-1],[0,1]] },
  { en: "Panda",    fi: "Panda",           k: "熊猫", d: "R", m: [[-1,1],[0,-1],[1,-1]] },
  { en: "Bear",     fi: "Karhu",           k: "熊",   d: "L", m: [[1,1],[0,-1],[-1,-1]] },
  { en: "Kirin",    fi: "Kirin",           k: "麒麟", d: "B", m: [[0,2],[1,-2],[-1,-2]] },
  { en: "Sea Snake",fi: "Merikäärme",      k: "海蛇", d: "R", m: [[-1,1],[0,-1],[2,0]] },
  { en: "Viper",    fi: "Kyy",             k: "蝮",   d: "L", m: [[1,1],[0,-1],[-2,0]] },
  { en: "Phoenix",  fi: "Feeniks",         k: "鳳",   d: "B", m: [[-2,0],[-1,-1],[1,-1],[2,0]] },
  { en: "Mouse",    fi: "Hiiri",           k: "鼠",   d: "R", m: [[-1,1],[0,-1],[1,0]] },
  { en: "Rat",      fi: "Rotta",           k: "鼡",   d: "L", m: [[1,1],[0,-1],[-1,0]] },
  { en: "Turtle",   fi: "Kilpikonna",      k: "亀",   d: "B", m: [[-2,0],[-1,1],[1,1],[2,0]] },
  { en: "Tanuki",   fi: "Tanuki",          k: "狸",   d: "R", m: [[-1,1],[0,-1],[2,-1]] },
  { en: "Iguana",   fi: "Iguaani",         k: "蜥",   d: "L", m: [[1,1],[0,-1],[-2,-1]] },
  { en: "Sable",    fi: "Soopeli",         k: "貂",   d: "R", m: [[-2,0],[-1,1],[1,-1]] },
  { en: "Otter",    fi: "Saukko",          k: "獺",   d: "L", m: [[2,0],[1,1],[-1,-1]] },
];

const SET_BASE = Array.from({ length: 16 }, (_, i) => i);
const SET_SENSEI = Array.from({ length: 16 }, (_, i) => i + 16);

/* ==========================================================================
   2. Engine — ported from onitamalib/src/board.rs
      Grid: y = 0 is Blue's home row, y = 4 is Red's. Red moves toward y = 0.
      Blue's card deltas are negated. Red wins at (2,0), Blue at (2,4).
   ========================================================================== */

const RED_GOAL = { x: 2, y: 0 };   // Blue's temple — Red's objective
const BLUE_GOAL = { x: 2, y: 4 };  // Red's temple — Blue's objective

const other = (s) => (s === "red" ? "blue" : "red");
const same = (a, b) => a && b && a.x === b.x && a.y === b.y;
const inBounds = (p) => p.x >= 0 && p.x < 5 && p.y >= 0 && p.y < 5;

function newBoard(deckIds) {
  const deck = shuffled(deckIds);
  const pawnXs = [0, 1, 3, 4];
  return {
    blueKing: { x: 2, y: 0 },
    bluePawns: pawnXs.map((x) => ({ x, y: 0 })),
    blueHand: [deck[0], deck[1]],
    redKing: { x: 2, y: 4 },
    redPawns: pawnXs.map((x) => ({ x, y: 4 })),
    redHand: [deck[2], deck[3]],
    spare: deck[4],
    turn: "red",
  };
}

function cloneBoard(b) {
  const pt = (p) => (p ? { x: p.x, y: p.y } : null);
  return {
    blueKing: pt(b.blueKing),
    bluePawns: b.bluePawns.map(pt),
    blueHand: b.blueHand.slice(),
    redKing: pt(b.redKing),
    redPawns: b.redPawns.map(pt),
    redHand: b.redHand.slice(),
    spare: b.spare,
    turn: b.turn,
  };
}

const handOf = (b, s) => (s === "red" ? b.redHand : b.blueHand);
const kingOf = (b, s) => (s === "red" ? b.redKing : b.blueKing);
const pawnsOf = (b, s) => (s === "red" ? b.redPawns : b.bluePawns);

/** Every occupied square for one side, king first. */
function piecesOf(b, s) {
  const out = [{ p: kingOf(b, s), king: true }];
  for (const p of pawnsOf(b, s)) if (p) out.push({ p, king: false });
  return out;
}

function pieceAt(b, pt) {
  for (const s of ["red", "blue"]) {
    for (const it of piecesOf(b, s)) {
      if (same(it.p, pt)) return { side: s, king: it.king };
    }
  }
  return null;
}

/** Card deltas seen from `side`'s end of the mat. */
function deltasFor(side, cardId) {
  const f = side === "red" ? 1 : -1;
  return CARDS[cardId].m.map(([x, y]) => ({ x: x * f, y: y * f }));
}

/** Legal destinations for one piece with one card (own pieces block). */
function targetsFor(b, src, cardId) {
  const mine = piecesOf(b, b.turn).map((it) => it.p);
  const out = [];
  for (const d of deltasFor(b.turn, cardId)) {
    const t = { x: src.x + d.x, y: src.y + d.y };
    if (!inBounds(t)) continue;
    if (mine.some((p) => same(p, t))) continue;
    out.push(t);
  }
  return out;
}

/** Squares holding a piece that has at least one move with this card. */
function movableWith(b, cardId) {
  return piecesOf(b, b.turn)
    .filter((it) => targetsFor(b, it.p, cardId).length > 0)
    .map((it) => it.p);
}

function canMove(b) {
  return handOf(b, b.turn).some((c) => movableWith(b, c).length > 0);
}

/**
 * Apply a move. Returns { board, captured, winner, reason } or null when illegal.
 * `captured` describes the removed piece so the renderer can splash ink on it.
 */
function applyMove(b, cardId, src, dst) {
  if (!handOf(b, b.turn).includes(cardId)) return null;
  const mover = pieceAt(b, src);
  if (!mover || mover.side !== b.turn) return null;
  if (!inBounds(dst)) return null;
  const occupant = pieceAt(b, dst);
  if (occupant && occupant.side === b.turn) return null;

  const raw = { x: dst.x - src.x, y: dst.y - src.y };
  const f = b.turn === "red" ? 1 : -1;
  const asRed = { x: raw.x * f, y: raw.y * f };
  if (!CARDS[cardId].m.some(([x, y]) => x === asRed.x && y === asRed.y)) return null;

  const nb = cloneBoard(b);
  const me = b.turn;
  const foe = other(me);
  const movingKing = same(kingOf(b, me), src);

  // move my piece
  if (movingKing) {
    if (me === "red") nb.redKing = { ...dst }; else nb.blueKing = { ...dst };
  } else {
    const pawns = me === "red" ? nb.redPawns : nb.bluePawns;
    for (let i = 0; i < pawns.length; i++) if (same(pawns[i], src)) pawns[i] = { ...dst };
  }

  // clear a captured enemy pawn (a captured king simply ends the game)
  let captured = null;
  if (occupant) {
    captured = { side: occupant.side, king: occupant.king, at: { ...dst } };
    if (!occupant.king) {
      const pawns = foe === "red" ? nb.redPawns : nb.bluePawns;
      for (let i = 0; i < pawns.length; i++) if (same(pawns[i], dst)) pawns[i] = null;
    }
  }

  // played card goes to the side, spare comes into hand
  const hand = me === "red" ? nb.redHand : nb.blueHand;
  for (let i = 0; i < hand.length; i++) if (hand[i] === cardId) hand[i] = b.spare;
  nb.spare = cardId;
  nb.turn = foe;

  const goal = me === "red" ? RED_GOAL : BLUE_GOAL;
  let winner = null, reason = null;
  if (occupant && occupant.king) { winner = me; reason = "capture"; }
  else if (movingKing && same(dst, goal)) { winner = me; reason = "temple"; }

  return { board: nb, captured, winner, reason };
}

/** Discard a card when no legal move exists (Move::Discard in the Rust lib). */
function applyDiscard(b, cardId) {
  if (canMove(b)) return null;
  if (!handOf(b, b.turn).includes(cardId)) return null;
  const nb = cloneBoard(b);
  const hand = b.turn === "red" ? nb.redHand : nb.blueHand;
  for (let i = 0; i < hand.length; i++) if (hand[i] === cardId) hand[i] = b.spare;
  nb.spare = cardId;
  nb.turn = other(b.turn);
  return { board: nb, captured: null, winner: null, reason: null };
}

/* --------------------------------------------------------------------------
   Player-made cards

   CARDS is indexed by card id. Built-in cards occupy 0..31; anything a player
   draws lives at CUSTOM_BASE and up, so the two can never collide and a saved
   game or a room on the server keeps meaning the same card.
   -------------------------------------------------------------------------- */

const CUSTOM_BASE = 1000;

/** Install a set of custom cards (replacing any previously installed ones). */
function setCustomCards(list) {
  for (let i = CARDS.length - 1; i >= CUSTOM_BASE; i--) delete CARDS[i];
  CARDS.length = Math.min(CARDS.length, SET_BASE.length + SET_SENSEI.length);
  for (const c of list || []) {
    if (!c || typeof c.id !== "number" || c.id < CUSTOM_BASE) continue;
    CARDS[c.id] = {
      en: c.en || c.name || "Custom",
      fi: c.fi || c.name || "Oma",
      k: c.k || "私",
      d: c.d || "B",
      m: (c.m || []).map(([x, y]) => [x, y]),
      custom: true,
    };
  }
}

const isCustom = (id) => id >= CUSTOM_BASE;

return {
  DIR, CARDS, SET_BASE, SET_SENSEI, RED_GOAL, BLUE_GOAL,
  CUSTOM_BASE, setCustomCards, isCustom,
  other, same, inBounds, shuffled,
  newBoard, cloneBoard, handOf, kingOf, pawnsOf, piecesOf, pieceAt,
  deltasFor, targetsFor, movableWith, canMove, applyMove, applyDiscard,
};
});
