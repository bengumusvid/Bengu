// Supabase Edge Function: mpesa-pay  (cobra a taxa de publicação por M-Pesa, C2B single stage)
import { createClient } from "npm:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// O M-Pesa não usa OAuth: o "Bearer" é a API Key cifrada com a Public Key (RSA, PKCS#1 v1.5), em base64.
function bearer(): string {
  let pk = Deno.env.get("MPESA_PUBLIC_KEY")!.trim();
  if (!pk.includes("BEGIN")) pk = "-----BEGIN PUBLIC KEY-----\n" + pk.replace(/\s+/g, "").match(/.{1,64}/g)!.join("\n") + "\n-----END PUBLIC KEY-----";
  const key = forge.pki.publicKeyFromPem(pk);
  return forge.util.encode64(key.encrypt(Deno.env.get("MPESA_API_KEY")!, "RSAES-PKCS1-V1_5"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await svc.auth.getUser(jwt);
    if (!user) return J({ error: "Sessão inválida. Entre de novo." }, 401);

    const { phone } = await req.json();
    const msisdn = String(phone || "").replace(/\D/g, "");
    if (!/^258(84|85)\d{7}$/.test(msisdn)) return J({ error: "Use um número M-Pesa (Vodacom) no formato 25884XXXXXXX." }, 400);

    // o preço é calculado no servidor, nunca vem do telemóvel
    const { data: q, error: qe } = await svc.rpc("fee_quote", { p_user: user.id });
    if (qe || !q) return J({ error: qe?.message || "Erro a calcular a taxa." }, 400);
    if (!q.amount_mzn || q.amount_mzn <= 0) return J({ error: "Não há taxa a pagar." }, 400);

    const ref = ("BG" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase().slice(0, 20);
    const third = ("T" + Math.random().toString(36).slice(2, 12)).toUpperCase();
    await svc.from("publication_fees").insert({ user_id: user.id, region: q.region, amount_mzn: q.amount_mzn, phone: msisdn, reference: ref });

    const base = Deno.env.get("MPESA_BASE") || "https://api.vm.co.mz:18352"; // sandbox: https://api.sandbox.vm.co.mz:18352
    const r = await fetch(base + "/ipg/v1x/c2bPayment/singleStage/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + bearer(), Origin: "developer.mpesa.vm.co.mz" },
      body: JSON.stringify({
        input_TransactionReference: ref,
        input_CustomerMSISDN: msisdn,
        input_Amount: String(q.amount_mzn),
        input_ThirdPartyReference: third,
        input_ServiceProviderCode: Deno.env.get("MPESA_SHORTCODE"),
      }),
    });
    const d = await r.json().catch(() => ({}));
    const ok = d.output_ResponseCode === "INS-0";
    await svc.rpc("fee_mark", { p_ref: ref, p_ok: ok, p_code: d.output_ResponseCode ?? null, p_desc: d.output_ResponseDesc ?? null });
    return J(ok ? { ok: true } : { error: d.output_ResponseDesc || "Pagamento não concluído." }, ok ? 200 : 402);
  } catch (e) {
    return J({ error: String(e) }, 500);
  }
});
