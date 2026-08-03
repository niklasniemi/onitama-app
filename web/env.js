/* ==========================================================================
   Runtime configuration.

   This file is plain static JavaScript on purpose: Vercel serves web/ with no
   build step, so there is nothing to substitute NEXT_PUBLIC_* into. Edit the
   production URL below once, commit, and the deploy picks it up.

   Overrides, highest first:
     1. ?server=https://...   (ad-hoc testing against another backend)
     2. this file
   Leave SOCKET_URL empty to hide online play entirely (offline build).
   ========================================================================== */

(function () {
  window.ENV = window.ENV || {};
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  window.ENV.SOCKET_URL = local
    ? "http://localhost:3000"
    // ↓ replace with your Render URL after the first deploy
    : "https://onitama-backend.onrender.com";
})();
