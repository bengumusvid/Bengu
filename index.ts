// Assistente IA do Bengu. A chave da IA fica SÓ aqui (segredo do servidor), nunca na app.
// Deploy: supabase functions deploy bengu-ai
// Segredo: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const MODEL = "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SYSTEM = `Você é o assistente do Bengu, uma rede social africana em português com publicações, mensagens, notícias, torneios de futebol/andebol/basquetebol e competições de cantores, humoristas e criadores de conteúdo digital.
Responda sempre em português claro e simples, de forma curta e amigável.
Pode ajudar a: escrever legendas e publicações, ideias de conteúdo, apresentação (bio) de concorrentes, como pedir votos de forma educada, como criar e gerir um concurso (fechar inscrições, partilhar, cancelar), e dúvidas gerais.
Não invente regras, preços ou funcionalidades do Bengu que não conheça; diga que não tem essa informação e sugira contactar a administração.
Recuse conteúdo ilegal, violento, sexual envolvendo menores, assédio ou burlas. Não peça nem aceite palavras-passe ou dados de pagamento.`;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "método inválido" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: "Inicie sessão para usar a IA." }, 401);

    const body = await req.json().catch(() => ({}));
    const msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-10)
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Escreva uma mensagem." }, 400);

    const { data: ok, error: qe } = await sb.rpc("ai_take_quota");
    if (qe) return json({ error: "Serviço de IA ainda não configurado (SQL 4.11)." }, 500);
    if (!ok) return json({ error: "Atingiu o limite de mensagens por hora. Tente mais tarde." }, 429);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: msgs }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "A IA não respondeu agora. Tente de novo." }, 502);
    const reply = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    return json({ reply: reply || "Não consegui responder. Reformule a pergunta." });
  } catch (_e) {
    return json({ error: "Erro inesperado. Tente de novo." }, 500);
  }
});
