// BENGU · Supabase Edge Function "sms-hook" (Send SMS hook) com Mocean
// Segredos (Edge Functions > Secrets): MOCEAN_TOKEN, SEND_SMS_HOOK_SECRET, e opcional MOCEAN_FROM (nome do remetente)
// Ao criar a função, desligue "Verify JWT" (a protecção é a assinatura do hook).
import { Webhook } from "npm:standardwebhooks@1.0.0";

const hookSecret = (Deno.env.get("SEND_SMS_HOOK_SECRET") || "").replace("v1,whsec_", "");
const TOKEN = Deno.env.get("MOCEAN_TOKEN");
const FROM = Deno.env.get("MOCEAN_FROM") || "Bengu";

const fail = (code: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: code, message } }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("not allowed", { status: 405 });
  if (!hookSecret || !TOKEN) return fail(500, "Configuração em falta");

  let user: any, sms: any;
  try {
    const payload = await req.text();
    ({ user, sms } = new Webhook(hookSecret).verify(payload, Object.fromEntries(req.headers)));
  } catch {
    return fail(401, "Assinatura inválida");
  }

  const to = String(user?.phone || "").replace(/\D/g, "");
  if (!to || !sms?.otp) return fail(400, "Pedido inválido");

  const body = new URLSearchParams({
    "mocean-from": FROM,
    "mocean-to": to,
    "mocean-text": `Bengu: o seu código é ${sms.otp}`,
    "mocean-resp-format": "json",
  });

  try {
    const r = await fetch("https://rest.moceanapi.com/rest/2/sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && (Array.isArray(j.messages)
      ? j.messages.every((m: any) => Number(m.status) === 0)
      : Number(j.status ?? 0) === 0);
    if (!ok) {
      console.error("Mocean respondeu", r.status, JSON.stringify(j));
      return fail(502, "Falha ao enviar o SMS");
    }
  } catch (e) {
    console.error("Erro a chamar o Mocean", e);
    return fail(502, "Falha ao enviar o SMS");
  }

  return new Response("{}", { headers: { "Content-Type": "application/json" } });
});
