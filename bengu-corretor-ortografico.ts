// Bengu 4.29 · Função "bengu-corrigir" (Supabase Edge Function): corretor ortográfico com IA, só para o administrador.
// Publicar:  supabase functions deploy bengu-corrigir
// Segredo:   supabase secrets set ANTHROPIC_API_KEY=...   (opcional: BENGU_CORRETOR_MODEL)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: isAdmin } = await sb.rpc("is_admin");
    if (isAdmin !== true) return json({ error: "Só o administrador." }, 403);

    const { text } = await req.json();
    if (typeof text !== "string" || !text.trim()) return json({ error: "Texto vazio." }, 400);
    if (text.length > 4000) return json({ error: "Texto demasiado longo (máx. 4000 caracteres)." }, 400);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("BENGU_CORRETOR_MODEL") ?? "claude-haiku-5-5",
        max_tokens: 2000,
        system:
          "Corrige apenas ortografia, acentuação, pontuação e erros gramaticais evidentes do texto, na mesma língua do texto " +
          "(português de Angola, Moçambique ou Portugal, ou outra). Não mudes o sentido, o tom, os nomes, as hashtags, as " +
          "menções, os emojis nem as ligações. Responde só com o texto corrigido, sem explicações nem aspas.",
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!r.ok) return json({ error: "Falha no serviço de correção." }, 502);
    const d = await r.json();
    const out = (d.content ?? []).filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text).join("").trim();
    return json({ text: out || text });
  } catch (_e) {
    return json({ error: "Erro inesperado." }, 500);
  }
});
