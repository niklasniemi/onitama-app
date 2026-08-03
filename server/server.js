/* ==========================================================================
   Onitama — realtime multiplayer server (Express + Socket.io)
   Deployed to Render. The frontend is static and lives on Vercel.

   The server is authoritative: it owns the board, and every move is validated
   with ../web/engine.js — the exact same rules file the browser runs. A client
   can never advance the game by sending a move the engine rejects.
   ========================================================================== */

"use strict";

const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// The repo is checked out whole on Render, so the shared engine is one hop up.
// Keeping a single copy is the point: duplicated rules would silently drift.
const {
  SET_BASE, SET_SENSEI, newBoard, pieceAt, applyMove, applyDiscard, canMove,
  setCustomCards, CUSTOM_BASE,
} = require("../web/engine.js");

const PORT = process.env.PORT || 3000;

// Comma-separated list, e.g. "https://onitama.vercel.app,https://onitama.fi".
// Unset means "any origin", which is fine locally but should be set in prod.
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const corsOrigin = ALLOWED.length ? ALLOWED : true;

const ROOM_TTL_MS = 10 * 60 * 1000;   // an abandoned room is kept this long
const GRACE_MS = 2 * 60 * 1000;       // a dropped player may reclaim their seat
const MAX_ROOMS = 400;                // free-tier memory guard

const app = express();
app.set("trust proxy", 1);

// Render pings this; it is also handy for waking a sleeping free instance
// before the player actually needs the socket.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});
app.get("/", (_req, res) => res.type("text").send("Onitama realtime server"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  pingInterval: 20000,
  pingTimeout: 25000,
});

/* --------------------------------------------------------------------------
   Rooms
   -------------------------------------------------------------------------- */

/** @type {Map<string, Room>} */
const rooms = new Map();

// No O/0 or I/1 — codes get read aloud and typed by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function newToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deckFor(sets, customCards) {
  // An exact pick from the host wins outright, the same rule the client uses.
  const picked = (sets && Array.isArray(sets.picked)) ? sets.picked.filter(Number.isInteger) : [];
  if (picked.length >= 5) return picked;
  const ids = [];
  if (!sets || sets.base !== false) ids.push(...SET_BASE);
  if (sets && sets.sensei) ids.push(...SET_SENSEI);
  if (sets && sets.custom) ids.push(...(customCards || []).map((c) => c.id));
  const blocked = new Set((sets && Array.isArray(sets.blocked)) ? sets.blocked : []);
  const left = ids.filter((id) => !blocked.has(id));
  if (left.length >= 5) return left;
  return ids.length >= 5 ? ids : SET_BASE.slice();
}

/** Keep only well-formed custom cards, so a client cannot inject junk. */
function sanitiseCards(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).filter((c) =>
    c && Number.isInteger(c.id) && c.id >= CUSTOM_BASE &&
    Array.isArray(c.m) && c.m.length >= 1 && c.m.length <= 8 &&
    c.m.every((d) => Array.isArray(d) && d.length === 2 &&
      Number.isInteger(d[0]) && Number.isInteger(d[1]) &&
      Math.abs(d[0]) <= 2 && Math.abs(d[1]) <= 2)
  ).map((c) => ({
    id: c.id,
    fi: String(c.fi || c.name || "Oma").slice(0, 20),
    en: String(c.en || c.name || "Custom").slice(0, 20),
    k: String(c.k || "私").slice(0, 2),
    d: ["B", "L", "R"].includes(c.d) ? c.d : "B",
    m: c.m,
  }));
}

/**
 * Custom cards are per-room, so validation has to run with that room's table
 * installed. Node is single-threaded and applyMove is synchronous, so setting
 * it around the call is safe — nothing else can observe the swap.
 */
function withRoomCards(room, fn) {
  const cards = room.customCards || [];
  if (!cards.length) return fn();
  setCustomCards(cards);
  try { return fn(); } finally { setCustomCards([]); }
}

function createRoom(sets, customCards) {
  const code = newCode();
  if (!code) return null;
  const cards = sanitiseCards(customCards);
  if (cards.length) setCustomCards(cards);       // needed to deal the opening hand
  const room = {
    code,
    customCards: cards,
    createdAt: Date.now(),
    sets: { base: !(sets && sets.base === false), sensei: !!(sets && sets.sensei),
            custom: !!(sets && sets.custom) && cards.length > 0 },
    board: newBoard(deckFor(sets, cards)),
    lastMove: null,
    winner: null,
    reason: null,
    turns: 0,
    captures: 0,
    seats: { red: null, blue: null },
    rematch: { red: false, blue: false },
    touchedAt: Date.now(),
    reapTimer: null,
  };
  if (cards.length) setCustomCards([]);          // never leave a table installed
  rooms.set(code, room);
  return room;
}

function dropRoom(room) {
  clearTimeout(room.reapTimer);
  rooms.delete(room.code);
  publishRooms();
}

/** Reap once both seats have been empty for the grace period. */
function scheduleReap(room) {
  clearTimeout(room.reapTimer);
  const anyoneHere = ["red", "blue"].some((s) => room.seats[s] && room.seats[s].connected);
  if (anyoneHere) return;
  room.reapTimer = setTimeout(() => {
    const stillEmpty = ["red", "blue"].every((s) => !room.seats[s] || !room.seats[s].connected);
    if (stillEmpty) dropRoom(room);
  }, GRACE_MS);
}

const seated = (room, side) => !!room.seats[side];
const online = (room, side) => !!(room.seats[side] && room.seats[side].connected);

/** Everything a client needs to render and to animate the move that just landed. */
function statePayload(room) {
  return {
    code: room.code,
    board: room.board,
    lastMove: room.lastMove,
    turns: room.turns,
    captures: room.captures,
    winner: room.winner,
    reason: room.reason,
    sets: room.sets,
    customCards: room.customCards,
    players: { red: online(room, "red"), blue: online(room, "blue") },
    rematch: { ...room.rematch },
  };
}

function broadcast(room) {
  room.touchedAt = Date.now();
  io.to(room.code).emit("update-game-state", statePayload(room));
  publishRooms();
}

/* --------------------------------------------------------------------------
   Open-room browser

   Sockets sitting in the "lobby" channel get the list of rooms waiting for an
   opponent, so joining is a tap rather than a typed code.
   -------------------------------------------------------------------------- */

const LOBBY = "lobby";

function openRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (room.winner) continue;
    const taken = ["red", "blue"].filter((s) => online(room, s)).length;
    if (taken !== 1) continue;                    // full, or nobody home
    out.push({
      code: room.code,
      sets: room.sets,
      custom: (room.customCards || []).length,
      waiting: online(room, "red") ? "red" : "blue",
      age: Date.now() - room.createdAt,
    });
  }
  return out.sort((a, b) => a.age - b.age).slice(0, 30);
}

let publishTimer = null;
function publishRooms() {
  // rooms change in bursts (join fires several broadcasts) — coalesce them
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    io.to(LOBBY).emit("rooms-updated", { rooms: openRooms() });
  }, 120);
}

function resetRoom(room) {
  room.board = newBoard(deckFor(room.sets, room.customCards));
  room.lastMove = null;
  room.winner = null;
  room.reason = null;
  room.turns = 0;
  room.captures = 0;
  room.rematch = { red: false, blue: false };
}

/* --------------------------------------------------------------------------
   Connections
   -------------------------------------------------------------------------- */

const ok = (cb, data) => { if (typeof cb === "function") cb({ ok: true, ...data }); };
const fail = (cb, error) => { if (typeof cb === "function") cb({ ok: false, error }); };

/** The room and seat this socket is sitting in, if any. */
function seatOf(socket) {
  const { code, side } = socket.data || {};
  if (!code || !side) return null;
  const room = rooms.get(code);
  if (!room) return null;
  const seat = room.seats[side];
  if (!seat || seat.socketId !== socket.id) return null;
  return { room, side, seat };
}

io.on("connection", (socket) => {
  // watch the open-room list
  socket.on("browse-rooms", (payload, cb) => {
    if (payload && payload.stop === true) {
      socket.leave(LOBBY);
      return ok(cb, {});
    }
    socket.join(LOBBY);
    ok(cb, { rooms: openRooms() });
  });

  socket.on("create-room", (payload, cb) => {
    if (rooms.size >= MAX_ROOMS) return fail(cb, "server-busy");
    const room = createRoom(payload && payload.sets, payload && payload.customCards);
    if (!room) return fail(cb, "server-busy");
    const token = newToken();
    room.seats.red = { token, socketId: socket.id, connected: true };
    socket.data = { code: room.code, side: "red", token };
    socket.join(room.code);
    socket.leave(LOBBY);
    ok(cb, { code: room.code, side: "red", token, state: statePayload(room) });
    publishRooms();
  });

  socket.on("join-room", (payload, cb) => {
    const code = String((payload && payload.code) || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return fail(cb, "no-such-room");

    const token = payload && payload.token;
    // Reclaiming a seat after a dropped connection takes priority over sitting down.
    let side = ["red", "blue"].find((s) => room.seats[s] && token && room.seats[s].token === token);
    const rejoin = !!side;
    if (!side) side = ["red", "blue"].find((s) => !seated(room, s) || !online(room, s));
    if (!side) return fail(cb, "room-full");

    const seatToken = rejoin ? token : newToken();
    room.seats[side] = { token: seatToken, socketId: socket.id, connected: true };
    socket.data = { code, side, token: seatToken };
    socket.join(code);
    clearTimeout(room.reapTimer);

    socket.leave(LOBBY);
    ok(cb, { code, side, token: seatToken, rejoined: rejoin, state: statePayload(room) });
    socket.to(code).emit("opponent-joined", { side, rejoined: rejoin });
    broadcast(room);
  });

  socket.on("make-move", (payload, cb) => {
    const at = seatOf(socket);
    if (!at) return fail(cb, "not-in-room");
    const { room, side } = at;
    if (room.winner) return fail(cb, "game-over");
    if (room.board.turn !== side) return fail(cb, "not-your-turn");
    if (!online(room, other(side))) return fail(cb, "opponent-away");

    const { card, src, dst } = payload || {};
    if (!Number.isInteger(card) || !pt(src) || !pt(dst)) return fail(cb, "bad-move");

    const mover = withRoomCards(room, () => pieceAt(room.board, src));
    const res = withRoomCards(room, () => applyMove(room.board, card, src, dst));
    if (!res) return fail(cb, "illegal-move");   // the engine is the referee

    room.board = res.board;
    room.turns += 1;
    if (res.captured) room.captures += 1;
    room.winner = res.winner;
    room.reason = res.reason;
    room.lastMove = {
      card, src, dst,
      side: mover.side, king: mover.king,
      captured: res.captured,
      winner: res.winner, reason: res.reason,
    };
    ok(cb, {});
    broadcast(room);
  });

  socket.on("discard-card", (payload, cb) => {
    const at = seatOf(socket);
    if (!at) return fail(cb, "not-in-room");
    const { room, side } = at;
    if (room.winner) return fail(cb, "game-over");
    if (room.board.turn !== side) return fail(cb, "not-your-turn");
    if (withRoomCards(room, () => canMove(room.board))) return fail(cb, "moves-available");

    const res = withRoomCards(room, () => applyDiscard(room.board, (payload || {}).card));
    if (!res) return fail(cb, "illegal-discard");
    room.board = res.board;
    room.turns += 1;
    room.lastMove = { discarded: (payload || {}).card, side };
    ok(cb, {});
    broadcast(room);
  });

  // Both players have to ask, so nobody gets the board reset out from under them.
  socket.on("rematch", (_payload, cb) => {
    const at = seatOf(socket);
    if (!at) return fail(cb, "not-in-room");
    const { room, side } = at;
    room.rematch[side] = true;
    if (room.rematch.red && room.rematch.blue) resetRoom(room);
    ok(cb, {});
    broadcast(room);
  });

  socket.on("leave-room", (_payload, cb) => {
    const at = seatOf(socket);
    if (at) {
      at.room.seats[at.side] = null;
      at.room.rematch[at.side] = false;
      socket.leave(at.room.code);
      socket.to(at.room.code).emit("opponent-left", { side: at.side, permanent: true });
      broadcast(at.room);
      scheduleReap(at.room);
    }
    socket.data = {};
    ok(cb, {});
  });

  socket.on("disconnect", () => {
    const at = seatOf(socket);
    if (!at) return;
    const { room, side } = at;
    room.seats[side].connected = false;      // seat held, so the token can reclaim it
    socket.to(room.code).emit("opponent-left", { side, permanent: false, graceMs: GRACE_MS });
    broadcast(room);
    scheduleReap(room);
  });
});

const other = (s) => (s === "red" ? "blue" : "red");
const pt = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y);

// Sweep rooms nobody has touched in a long while (free instances restart often,
// but a long-lived one should not accumulate dead games).
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyoneHere = ["red", "blue"].some((s) => online(room, s));
    if (!anyoneHere && now - room.touchedAt > ROOM_TTL_MS) dropRoom(room);
  }
}, 60000).unref();

server.listen(PORT, () => {
  console.log(`Onitama server on :${PORT} — origins: ${ALLOWED.length ? ALLOWED.join(", ") : "(any)"}`);
});
