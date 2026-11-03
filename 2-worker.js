// Cloudflare Worker — rota: getbengu.com/s/*   (o resto do site continua no GitHub Pages)
const SB = "https://cnpkgauzhoyzlhtcexiv.supabase.co";
const KEY = "sb_publishable_pk8EKbcwtTdat2c8BXsIpg_Fm"; // chave pública, a mesma que a app já usa
const ICON = "https://getbengu.com/apple-touch-icon.png";
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const code = decodeURIComponent(url.pathname.replace(/^\/s\//, "")).trim();
    const home = `${url.origin}/#${encodeURIComponent(code)}`;
    if (!/^bengu[A-Za-z0-9_.~!*-]{10,60}$/.test(code)) return Response.redirect(url.origin + "/", 302);

    let d = null;
    try {
      const r = await fetch(`${SB}/rest/v1/rpc/share_preview`, {
        method: "POST",
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_code: code }),
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (r.ok) d = await r.json();
    } catch (e) {}

    const kind = { image: "Foto", video: "Vídeo", audio: "Música" }[d?.type] || "Publicação";
    const title = d?.name ? `${kind} de ${d.name} no Bengu` : "Veja isto no Bengu";
    const desc = d?.body || "Fotos, vídeos, música, notícias e concursos. Entre no Bengu.";
    const img = d?.type === "image" && d?.media ? d.media : d?.avatar || ICON;

    const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="Bengu">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:url" content="${esc(url.href)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(home)}"></head>
<body><script>location.replace(${JSON.stringify(home)})</script><a href="${esc(home)}">Abrir no Bengu</a></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
  },
};
