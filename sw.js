/* Bengu — service worker (uso offline)
   Colocar na mesma pasta do index.html (a app regista "./sw.js").
   - Guarda a app (index.html, manifest, ícones) para abrir sem internet.
   - Não mexe em pedidos a outros sites (Supabase, anúncios): esses precisam de rede.
   - Mantém a cache "bengu-share" (usada ao partilhar para o Bengu).
   Para novas versões, mude CACHE (ex.: bengu-shell-2). */
var CACHE = "bengu-shell-1";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./favicon-32.png", "./icon-192.png"];

/* Partilha de outras apps (Android → Bengu), se existir o ficheiro sw-share.js */
try { importScripts("sw-share.js"); } catch (e) {}

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.filter(function (k) {
        return k !== CACHE && k !== "bengu-share";
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var r = e.request;
  if (r.method !== "GET") return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;        /* Supabase, anúncios, etc.: sempre rede */
  if (u.search.indexOf("share=1") > -1) return;    /* ecrã de partilha: não usar cache */

  if (r.mode === "navigate") {                     /* abrir a app: rede primeiro, cache se offline */
    e.respondWith(
      fetch(r).then(function (res) {
        var cp = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", cp); });
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (m) { return m || caches.match("./"); });
      })
    );
    return;
  }

  e.respondWith(                                   /* ficheiros da app: cache já, atualiza em fundo */
    caches.match(r).then(function (m) {
      var net = fetch(r).then(function (res) {
        if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(r, cp); }); }
        return res;
      }).catch(function () { return m; });
      return m || net;
    })
  );
});

/* Tocar numa notificação abre a conversa */
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        if ("focus" in cs[i]) { cs[i].navigate(url).catch(function () {}); return cs[i].focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
