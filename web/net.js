/* ==========================================================================
   Onitama — Socket.io client layer

   Deliberately knows nothing about rendering. The game sets Net.hooks.* and
   calls Net.create / Net.join / Net.sendMove; everything else is transport.

   The socket.io client script is fetched from the backend itself
   (<backend>/socket.io/socket.io.js), so there is no third-party CDN in the
   page and the offline single-file build stays fully self-contained: nothing
   is loaded until the player actually chooses online play.
   ========================================================================== */

"use strict";

window.Net = (function () {
  const qs = new URLSearchParams(location.search);

  // Priority: ?server= (handy for testing against a deploy) → env.js → same host.
  const url = (qs.get("server")
    || (window.ENV && window.ENV.SOCKET_URL)
    || "").replace(/\/+$/, "");

  const N = {
    url,
    available: !!url,
    socket: null,
    code: null,
    side: null,
    token: null,
    connected: false,
    browsing: false,
    hooks: { state() {}, opponent() {}, status() {}, rooms() {} },
  };

  const setStatus = (status, detail) => {
    N.status = status;
    N.hooks.status(status, detail || null);
  };

  const tokenKey = (code) => "onitama.seat." + code;
  const saveToken = (code, token) => {
    try { sessionStorage.setItem(tokenKey(code), token); } catch (e) { /* private mode */ }
  };
  const loadToken = (code) => {
    try { return sessionStorage.getItem(tokenKey(code)); } catch (e) { return null; }
  };

  let libPromise = null;
  function loadLib() {
    if (window.io) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = N.url + "/socket.io/socket.io.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { libPromise = null; reject(new Error("lib")); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  /** Connect (loading the client library first). Resolves once the socket is up. */
  function connect() {
    if (!N.available) return Promise.reject(new Error("no-server"));
    if (N.socket && N.socket.connected) return Promise.resolve(N.socket);

    setStatus("connecting");
    return loadLib().then(() => new Promise((resolve, reject) => {
      if (!N.socket) {
        N.socket = window.io(N.url, {
          transports: ["websocket", "polling"],
          reconnectionDelay: 700,
          reconnectionDelayMax: 4000,
          timeout: 20000,
        });

        N.socket.on("connect", () => {
          N.connected = true;
          // A reconnect must reclaim the seat, or the server sees a stranger.
          if (N.code && N.token) {
            N.socket.emit("join-room", { code: N.code, token: N.token }, (res) => {
              if (res && res.ok) {
                N.side = res.side;
                setStatus("live");
                N.hooks.state(res.state);
              } else {
                setStatus("lost", (res && res.error) || "rejoin-failed");
              }
            });
          } else {
            setStatus("connected");
          }
        });

        N.socket.on("disconnect", () => {
          N.connected = false;
          setStatus("reconnecting");
        });
        N.socket.on("connect_error", () => {
          N.connected = false;
          setStatus("offline");
        });

        N.socket.on("update-game-state", (state) => N.hooks.state(state));
        N.socket.on("opponent-joined", (info) => N.hooks.opponent("joined", info));
        N.socket.on("opponent-left", (info) => N.hooks.opponent("left", info));
        N.socket.on("rooms-updated", (d) => N.hooks.rooms((d && d.rooms) || []));
      }

      if (N.socket.connected) return resolve(N.socket);

      // A sleeping free-tier instance can take the better part of a minute.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout"));
      }, 65000);
      const onOk = () => { cleanup(); resolve(N.socket); };
      const onErr = () => { cleanup(); reject(new Error("unreachable")); };
      function cleanup() {
        clearTimeout(timer);
        N.socket.off("connect", onOk);
        N.socket.off("connect_error", onErr);
      }
      N.socket.on("connect", onOk);
      N.socket.on("connect_error", onErr);
    })).catch((err) => {
      setStatus("offline", err.message);
      throw err;
    });
  }

  /** Wrap an emit in a promise so callers can await the server's verdict. */
  function ask(event, payload) {
    return new Promise((resolve, reject) => {
      if (!N.socket || !N.socket.connected) return reject(new Error("offline"));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("timeout")); }
      }, 12000);
      N.socket.emit(event, payload, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res && res.ok) resolve(res);
        else reject(new Error((res && res.error) || "refused"));
      });
    });
  }

  /** Start (or stop) watching the list of rooms waiting for an opponent. */
  N.browse = (on) => {
    if (!on) {
      N.browsing = false;
      if (N.socket && N.socket.connected) ask("browse-rooms", { stop: true }).catch(() => {});
      return Promise.resolve([]);
    }
    N.browsing = true;
    return connect()
      .then(() => ask("browse-rooms", {}))
      .then((res) => {
        const list = res.rooms || [];
        N.hooks.rooms(list);
        return list;
      });
  };

  N.create = (sets, customCards) => connect()
    .then(() => ask("create-room", { sets, customCards }))
    .then((res) => {
      N.code = res.code; N.side = res.side; N.token = res.token;
      saveToken(res.code, res.token);
      setStatus("waiting");
      return res;
    });

  N.join = (code) => {
    const clean = String(code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(clean)) return Promise.reject(new Error("bad-code"));
    return connect()
      .then(() => ask("join-room", { code: clean, token: loadToken(clean) }))
      .then((res) => {
        N.code = res.code; N.side = res.side; N.token = res.token;
        saveToken(res.code, res.token);
        setStatus("live");
        return res;
      });
  };

  N.sendMove = (card, src, dst) => ask("make-move", { card, src, dst });
  N.sendDiscard = (card) => ask("discard-card", { card });
  N.rematch = () => ask("rematch", {});

  N.leave = () => {
    const s = N.socket;
    N.code = null; N.side = null; N.token = null;
    if (!s || !s.connected) return Promise.resolve();
    return ask("leave-room", {}).catch(() => {});
  };

  /** Shareable join link for the current room. */
  N.inviteLink = () => {
    if (!N.code) return "";
    const u = new URL(location.href);
    u.searchParams.set("room", N.code);
    u.hash = "";
    return u.toString();
  };

  /** Room code from a shared link, if the page was opened with one. */
  N.linkedRoom = () => {
    const c = (qs.get("room") || "").trim().toUpperCase();
    return /^[A-Z0-9]{4}$/.test(c) ? c : null;
  };

  return N;
})();
