/* ==========================================================================
   End-to-end protocol test: two real socket.io clients against a live server.

   Run:  cd server && npm start          (in one terminal)
         node test-multiplayer.mjs       (in another)
   Or:   PORT=3101 node --test-server test-multiplayer.mjs   (boots its own)
   ========================================================================== */

import { io } from "socket.io-client";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const E = require("../web/engine.js");

const PORT = process.env.TEST_PORT || 3101;
const URL = `http://localhost:${PORT}`;
const BOOT = process.argv.includes("--test-server");

let child = null;
if (BOOT) {
  child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((r) => setTimeout(r, 900));
}

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? " — " + JSON.stringify(extra) : ""}`); }
};

const connect = () => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  s.once("connect", () => resolve(s));
  s.once("connect_error", reject);
});

const ask = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const once = (s, ev, ms = 4000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  s.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

try {
  console.log("\n1. room lifecycle");
  const a = await connect();
  const b = await connect();

  const created = await ask(a, "create-room", { sets: { base: true, sensei: true } });
  check("create-room returns a 4-char code", /^[A-Z0-9]{4}$/.test(created.code || ""), created);
  check("creator is red", created.side === "red", created.side);
  check("creator gets a seat token", typeof created.token === "string" && created.token.length > 5);
  check("initial board has red to move", created.state.board.turn === "red");

  const joined = await ask(b, "join-room", { code: created.code });
  check("joiner is blue", joined.side === "blue", joined);
  check("joiner sees both players", joined.state.players.red && joined.state.players.blue, joined.state.players);

  const c = await connect();
  const third = await ask(c, "join-room", { code: created.code });
  check("third player refused", third.ok === false && third.error === "room-full", third);
  const nowhere = await ask(c, "join-room", { code: "ZZZZ" });
  check("unknown code refused", nowhere.ok === false && nowhere.error === "no-such-room", nowhere);
  c.close();

  console.log("\n2. validation");
  const outOfTurn = await ask(b, "make-move", { card: created.state.board.blueHand[0], src: { x: 2, y: 0 }, dst: { x: 2, y: 1 } });
  check("out-of-turn move refused", outOfTurn.ok === false && outOfTurn.error === "not-your-turn", outOfTurn);

  const bogus = await ask(a, "make-move", { card: created.state.board.redHand[0], src: { x: 2, y: 4 }, dst: { x: 0, y: 0 } });
  check("illegal geometry refused", bogus.ok === false && bogus.error === "illegal-move", bogus);

  const notMine = await ask(a, "make-move", { card: created.state.board.redHand[0], src: { x: 2, y: 0 }, dst: { x: 2, y: 1 } });
  check("moving an enemy piece refused", notMine.ok === false, notMine);

  const cardNotHeld = await ask(a, "make-move", { card: created.state.board.spare, src: { x: 2, y: 4 }, dst: { x: 2, y: 3 } });
  check("card not in hand refused", cardNotHeld.ok === false, cardNotHeld);

  const junk = await ask(a, "make-move", { card: 99, src: null, dst: { x: 1, y: 1 } });
  check("malformed payload refused", junk.ok === false && junk.error === "bad-move", junk);

  console.log("\n3. a full game, driven only through the socket");
  const seats = { red: a, blue: b };
  let state = joined.state;
  const states = { red: null, blue: null };
  a.on("update-game-state", (s) => { states.red = s; });
  b.on("update-game-state", (s) => { states.blue = s; });

  let ply = 0, discards = 0, refusals = 0;
  while (!state.winner && ply < 300) {
    const board = state.board;
    const side = board.turn;
    const sock = seats[side];
    let res;
    if (!E.canMove(board)) {
      res = await ask(sock, "discard-card", { card: E.handOf(board, side)[0] });
      discards++;
    } else {
      const opts = [];
      for (const card of E.handOf(board, side)) {
        for (const it of E.piecesOf(board, side)) {
          for (const t of E.targetsFor(board, it.p, card)) opts.push([card, it.p, t]);
        }
      }
      const [card, src, dst] = opts[Math.floor(Math.random() * opts.length)];
      res = await ask(sock, "make-move", { card, src, dst });
    }
    if (!res.ok) { refusals++; break; }
    await new Promise((r) => setTimeout(r, 12));
    state = states[side] || state;
    ply++;
  }

  check("game reached a decision", !!state.winner, { ply, winner: state.winner });
  check("no legal move was refused", refusals === 0, { refusals });
  check("both clients agree on the final board",
    JSON.stringify(states.red.board) === JSON.stringify(states.blue.board));
  check("win reason is reported", state.reason === "temple" || state.reason === "capture", state.reason);
  check("lastMove carries animation data",
    !!(states.blue.lastMove && states.blue.lastMove.src && states.blue.lastMove.side), states.blue.lastMove);
  console.log(`     (${ply} plies, ${discards} discards, winner: ${state.winner} by ${state.reason})`);

  const afterEnd = await ask(seats[state.board.turn], "make-move", { card: 0, src: { x: 0, y: 0 }, dst: { x: 0, y: 1 } });
  check("moves after the win are refused", afterEnd.ok === false && afterEnd.error === "game-over", afterEnd);

  console.log("\n4. rematch needs both players");
  const turnsAtEnd = states.blue.turns;
  await ask(a, "rematch", {});
  await new Promise((r) => setTimeout(r, 60));   // let the broadcast land
  check("one request does not reset", states.blue.turns === turnsAtEnd && states.blue.rematch.red === true,
    { turns: states.blue.turns, rematch: states.blue.rematch });
  await ask(b, "rematch", {});
  await new Promise((r) => setTimeout(r, 60));
  check("both requests reset the board", states.red.turns === 0 && !states.red.winner, { turns: states.red.turns });

  console.log("\n5. disconnect and seat reclaim");
  const gone = once(a, "opponent-left");
  b.close();
  const notice = await gone;
  check("survivor is told the opponent left", notice && notice.side === "blue" && notice.permanent === false, notice);
  await new Promise((r) => setTimeout(r, 80));
  check("seat shows as empty", states.red.players.blue === false, states.red.players);

  const b2 = await connect();
  const rejoinBack = once(a, "opponent-joined");
  const rejoined = await ask(b2, "join-room", { code: created.code, token: joined.token });
  check("token reclaims the same seat", rejoined.ok && rejoined.side === "blue" && rejoined.rejoined === true, rejoined);
  const back = await rejoinBack;
  check("survivor is told they returned", back && back.rejoined === true, back);
  check("returning player receives the live board",
    JSON.stringify(rejoined.state.board) === JSON.stringify(states.red.board));

  console.log("\n6. leaving for good");
  const leftForGood = once(a, "opponent-left");
  await ask(b2, "leave-room", {});
  const bye = await leftForGood;
  check("explicit leave is permanent", bye && bye.permanent === true, bye);

  a.close(); b2.close();
} catch (err) {
  failures++;
  console.log("\nEXCEPTION:", err && err.message);
} finally {
  if (child) child.kill();
  console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
  process.exit(failures ? 1 : 0);
}
