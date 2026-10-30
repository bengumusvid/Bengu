// Supabase Edge Function: bengu-aviso
// Entrega os avisos do administrador (tabela bengu_warnings) no Bate-Papo e por email,
// em vez de os mostrar num pop-up no meio do ecrã.
//
// Segredos necessários (supabase secrets set ...):
//   BENGU_ADMIN_SENDER_ID  -> id (profiles.id) da conta que "envia" o aviso no Bate-Papo
//   RESEND_API_KEY         -> chave da Resend (https://resend.com) para enviar o email
//   RESEND_FROM            -> ex.: "Bengu <avisos@getbengu.com>" (domínio verificado na Resend)
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY já existem por defeito.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  // cliente com o token do utilizador: o RLS só devolve os avisos dele
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: ures } = await asUser.auth.getUser();
  const user = ures?.user;
  if (!user) return json({ error: "Sessão inválida." }, 401);

  const { data: warns, error } = await asUser
    .from("bengu_warnings")
    .select("id,message,created_at")
    .eq("seen", false)
    .order("created_at");
  if (error) return json({ error: error.message }, 500);
  if (!warns || !warns.length) return json({ sent: 0 });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // marca como entregues primeiro (evita duplicados se a função for chamada duas vezes)
  const ids = warns.map((w) => w.id);
  const { data: claimed } = await admin
    .from("bengu_warnings")
    .update({ seen: true })
    .in("id", ids)
    .eq("seen", false)
    .select("id,message,created_at");
  if (!claimed || !claimed.length) return json({ sent: 0 });

  // junta mensagens iguais (evita o mesmo aviso repetido)
  const msgs = [...new Set(claimed.map((w) => String(w.message || "").trim()).filter(Boolean))];
  if (!msgs.length) return json({ sent: 0 });

  // 1) Bate-Papo
  const sender = Deno.env.get("BENGU_ADMIN_SENDER_ID");
  let chat = false;
  if (sender && sender !== user.id) {
    const { error: e1 } = await admin.from("messages").insert(
      msgs.map((m) => ({ sender_id: sender, receiver_id: user.id, body: "⚠️ Aviso do administrador\n" + m })),
    );
    chat = !e1;
  }

  // 2) Email
  let mail = false;
  const key = Deno.env.get("RESEND_API_KEY");
  if (key && user.email) {
    const html =
      `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#12183A">` +
      `<h2>⚠️ Aviso do administrador</h2>` +
      msgs.map((m) => `<p style="line-height:1.5">${esc(m)}</p>`).join("") +
      `<p style="color:#667;font-size:13px">Bengu · https://getbengu.com</p></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("RESEND_FROM") ?? "Bengu <onboarding@resend.dev>",
        to: [user.email],
        subject: "Aviso do administrador · Bengu",
        html,
      }),
    });
    mail = r.ok;
  }

  // se nenhum canal funcionou, volta a marcar como não entregue para tentar mais tarde
  if (!chat && !mail) {
    await admin.from("bengu_warnings").update({ seen: false }).in("id", claimed.map((w) => w.id));
    return json({ sent: 0, error: "Nenhum canal disponível (verifique os segredos)." }, 500);
  }
  return json({ sent: msgs.length, chat, mail });
});
