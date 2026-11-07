/* Bengu — service worker offline-first (4.42). Guarda a app no telemóvel para abrir sem dados. */
try { importScripts("sw-share.js"); } catch (e) {}
var SHELL = "bengu-shell-v1", ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./apple-touch-icon.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(ASSETS.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return /^bengu-shell-/.test(k) && k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }));
});
function netFirst(req, key, ms) {
  return new Promise(function (ok) {
    var done = false, t = setTimeout(function () { if (!done) caches.match(key, { ignoreSearch: true }).then(function (r) { if (r && !done) { done = true; ok(r); } }); }, ms);
    fetch(req).then(function (res) {
      if (res && res.ok) { var cp = res.clone(); caches.open(SHELL).then(function (c) { c.put(key, cp); }); }
      if (!done) { done = true; clearTimeout(t); ok(res); }
    }).catch(function () {
      clearTimeout(t);
      caches.match(key, { ignoreSearch: true }).then(function (r) { if (!done) { done = true; ok(r || new Response("Offline", { status: 503 })); } });
    });
  });
}
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || r.cache === "no-store" || u.searchParams.has("_")) return;
  if (r.mode === "navigate" && u.origin === location.origin) { e.respondWith(netFirst(r, "./index.html", 3500)); return; }
  var font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (u.origin !== location.origin && !font) return;
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(r).then(function (hit) {
      var f = fetch(r).then(function (res) { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; }).catch(function () { return hit; });
      return hit || f;
    });
  }));
});
