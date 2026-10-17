// BENGU 4.18: pagamento de levantamento por M-Pesa (B2C, Vodacom Moçambique).
// ATENÇÃO: escrito sem acesso à documentação do seu contrato. Confirmar URL, porta,
// nomes dos campos e códigos de resposta com a documentação da Vodacom e testar em SANDBOX.
// Segredos necessários (supabase secrets set ...):
//   MPESA_BASE_URL, MPESA_API_KEY, MPESA_PUBLIC_KEY (base64, sem cabeçalhos PEM), MPESA_SHORTCODE
import { createClient } from "npm:@supabase/supabase-js@2";
import { publicEncrypt, constants } from "node:crypto";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Content-Type": "application/json" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

function bearer(): string {
  const pem = `-----BEGIN PUBLIC KEY-----\n${Deno.env.get("MPESA_PUBLIC_KEY")}\n-----END PUBLIC KEY-----`;
  return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(Deno.env.get("MPESA_API_KEY")!)).toString("base64");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  let id = "";
  try { id = String((await req.json()).id ?? ""); } catch { return out({ ok: false, error: "pedido inválido" }, 400); }
  if (!/^[0-9a-f-]{36}$/.test(id)) return out({ ok: false, error: "id inválido" }, 400);

  const b = await sb.rpc("bengu_payout_begin", { p_id: id }); // só administradores; bloqueia pagamentos duplicados
  if (b.error) return out({ ok: false, error: b.error.message }, 403);
  const w = b.data as { account: string; amount_local: number };

  let ok = false, ref = "", note = "";
  try {
    const r = await fetch(`${Deno.env.get("MPESA_BASE_URL")}/ipg/v1x/b2cPayment/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer()}`, Origin: "*" },
      body: JSON.stringify({
        input_TransactionReference: id.replaceAll("-", "").slice(0, 20),
        input_CustomerMSISDN: w.account,
        input_Amount: String(w.amount_local),
        input_ThirdPartyReference: id.replaceAll("-", "").slice(0, 20),
        input_ServiceProviderCode: Deno.env.get("MPESA_SHORTCODE"),
      }),
    });
    const j = await r.json().catch(() => ({}));
    ok = j.output_ResponseCode === "INS-0";
    ref = j.output_TransactionID ?? j.output_ConversationID ?? "";
    note = ok ? "" : `${j.output_ResponseCode ?? r.status}: ${j.output_ResponseDesc ?? "falhou"}`;
  } catch (e) { note = "sem resposta do M-Pesa; confirmar no portal antes de repetir"; }

  // se a rede falhar a meio, o pedido fica em "processing" para o administrador verificar à mão
  if (!ok && note.startsWith("sem resposta")) {
    await sb.from("bengu_withdrawals").update({ note }).eq("id", id);
    return out({ ok: false, error: note }, 502);
  }
  const f = await sb.rpc("bengu_payout_finish", { p_id: id, p_ok: ok, p_ref: ref, p_note: note });
  if (f.error) return out({ ok: false, error: f.error.message }, 500);
  return out({ ok, error: ok ? undefined : note });
});
