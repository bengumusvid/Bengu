/* BENGU: receber partilhas de outras aplicações (Android "Partilhar" -> Bengu)
   Usar no topo do sw.js existente:  importScripts("./sw-share.js");  */
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "POST" || !/\/share-receiver\/?$/.test(u.pathname)) return;
  e.stopImmediatePropagation();
  e.respondWith((async function () {
    var scope = self.registration.scope;
    try {
      var fd = await e.request.formData();
      var cache = await caches.open("bengu-share");
      // limpar partilhas antigas
      var old = await cache.keys();
      await Promise.all(old.map(function (r) { return cache.delete(r); }));
      var meta = { title: String(fd.get("title") || ""), text: String(fd.get("text") || ""), url: String(fd.get("url") || ""), files: [], at: Date.now() };
      var files = fd.getAll("media").filter(function (f) { return f && f.size; });
      for (var i = 0; i < files.length; i++) {
        await cache.put(scope + "__share/" + i, new Response(files[i], { headers: { "Content-Type": files[i].type || "application/octet-stream" } }));
        meta.files.push({ i: i, name: files[i].name || ("ficheiro-" + i), type: files[i].type || "", size: files[i].size });
      }
      await cache.put(scope + "__share/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    } catch (err) {}
    return Response.redirect(scope + "?share=1", 303);
  })());
});
