# Onitama — mobile web app

A phone-first Onitama with local play for two on one device and realtime online
play across two devices. No framework and no build step: `web/` is plain static
files, `server/` is a small authoritative Socket.io server.

```
web/            → Vercel (static)
  index.html      the whole UI
  engine.js       the rules — shared verbatim with the server
  net.js          Socket.io client layer
  env.js          runtime config (backend URL)
server/         → Render (Node)
  server.js       rooms, move validation, broadcasting
render.yaml     Render blueprint
```

`engine.js` lives in `web/` and is `require`d by the server so there is exactly
one copy of the rules. The server validates every move with the same code the
browser ran, so the two can never disagree. The rules themselves are a port of
`onitamalib/` (`cards.rs`, `board.rs`): 32 cards across the base set and
Sensei's Path with their exact deltas and index order, Blue's inverted deltas,
capture and temple wins, and the forced discard when no legal move exists.

## Play locally

```bash
cd server && npm install && npm start
```

```bash
cd web && python3 -m http.server 8137
```

`env.js` points at `http://localhost:3000` whenever the page is served from
localhost, so online play works between two browser tabs with no configuration.

Protocol tests, driving two real socket clients through a full game:

```bash
cd server && node test-multiplayer.mjs --test-server
```

## Deploy

### 1. Backend on Render

Push the repo to GitHub, then in Render pick **New → Blueprint** and select it.
`render.yaml` describes the service, including `rootDir: server`. Render checks
out the whole repo, which is why `require("../web/engine.js")` resolves.

Set `ALLOWED_ORIGINS` to your Vercel domains, comma separated — include preview
domains or CORS will block them:

```
https://your-app.vercel.app,https://your-app-git-main-you.vercel.app
```

The free plan sleeps after ~15 minutes idle, so the first connection afterwards
takes 30–60 seconds while the instance wakes; the menu says "waking the server"
once the wait becomes noticeable. Rooms live in memory, so a restart drops them.

### 2. Frontend on Vercel

**New Project → import the repo**, then set:

- **Root Directory**: `web`
- **Framework Preset**: Other
- Build command and output directory: leave empty

Then put your Render URL into `web/env.js`, commit and push:

```js
window.ENV.SOCKET_URL = local
  ? "http://localhost:3000"
  : "https://YOUR-SERVICE.onrender.com";
```

`env.js` is deliberately a plain file rather than a `NEXT_PUBLIC_*` variable:
with no build step there is nothing to substitute one in. If you later add a
bundler, read `process.env.NEXT_PUBLIC_SOCKET_URL` there instead.

To point a deployed frontend at a different backend without redeploying, append
`?server=https://other-host` to the URL.

### 3. Check it

Open the Vercel URL on two devices, choose **Verkkopeli / Online**, create a
room on one and tap it in the other's open-room list.

## Design notes

- **Both hands are the same size.** What the opponent holds, and which card is
  waiting at the side, shape your move as much as your own hand does, so they
  get equal reading room. The reserve card sits in the turn bar with an arrow
  showing who receives it next.
- **Pick the piece, then the square.** Tapping a piece shows every square it can
  reach with either card, and the card spent matches where you send it. Tap a
  card first to force that one.
- **No hand-over prompt in local play.** Whose turn it is is obvious from the
  board; the mat simply turns to face the player to move.
- **Cards, colours and custom cards** persist in `localStorage` under
  `onitama.prefs.v1`. Favourite with the heart, or cycle a card free → picked →
  blocked; five or more picks becomes the exact deck. Custom cards take ids from
  1000 up so they can never collide with the 32 built-ins, and a room carries
  its host's custom cards to the server, which installs them only while
  validating that room's moves.
- Sizes are computed in JS (`sizeCards`, `layoutBoard`) rather than CSS, because
  two full card rows and a square mat compete for the same screen. The board is
  derived arithmetically from the viewport — measuring its own container would
  let the old canvas size hold the row open, and the mat could never shrink.
- Game state advances on timers as well as animation frames, so a throttled or
  suspended render loop cannot leave a move half-committed.
