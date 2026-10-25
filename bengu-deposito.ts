// Bengu 4.33 · Função "bengu-deposito" (Supabase Edge Function): depósito na Conta Bengu por M-Pesa (C2B síncrono).
// NÃO TESTADA. Confirme os nomes dos campos e os códigos de resposta no portal developer.mpesa.vm.co.mz.
// Publicar:  supabase functions deploy bengu-deposito
// Segredos:  supabase secrets set MPESA_API_KEY=... MPESA_PUBLIC_KEY=... MPESA_SERVICE_PROVIDER_CODE=...
//            (opcionais) MPESA_ENV=sandbox|production  (por defeito sandbox)   MPESA_ORIGIN=developer.mpesa.vm.co.mz
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { publicEncrypt, constants } from "node:crypto";
import { Buffer } from "node:buffer";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function pem(key: string): string {
  if (key.includes("BEGIN")) return key;
  const body = key.replace(/\s+/g, "").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let depositId: string | null = null;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    // 1) quem é o utilizador
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Inicie sessão." }, 401);

    // 2) validar pedido
    const { amount_usd, phone } = await req.json();
    const amt = Math.round(Number(amount_usd) * 100) / 100;
    if (!(amt >= 1 && amt <= 500)) return json({ ok: false, error: "Valor entre 1 e 500 US$." }, 400);
    if (!/^258(84|85)\d{7}$/.test(String(phone))) return json({ ok: false, error: "Número M-Pesa inválido." }, 400);

    // 3) converter para meticais e registar o depósito como pendente
    const { data: fx } = await admin.from("bengu_flags").select("value").eq("key", "usd_mzn_rate").maybeSingle();
    const rate = Number(fx?.value ?? 64);
    const mzn = Math.round(amt * rate * 100) / 100;
    const { data: dep, error: e1 } = await admin.from("bengu_deposits")
      .insert({ user_id: u.user.id, amount_usd: amt, amount_mzn: mzn, phone }).select("id").single();
    if (e1 || !dep) return json({ ok: false, error: "Não foi possível iniciar o depósito." }, 500);
    depositId = dep.id;

    // 4) pedir o pagamento ao M-Pesa (o cliente confirma no telemóvel)
    const host = (Deno.env.get("MPESA_ENV") ?? "sandbox") === "production"
      ? "https://api.vm.co.mz:18352" : "https://api.sandbox.vm.co.mz:18352";
    const token = publicEncrypt(
      { key: pem(Deno.env.get("MPESA_PUBLIC_KEY")!), padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(Deno.env.get("MPESA_API_KEY")!),
    ).toString("base64");
    const ref = "BG" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 90000);
    const r = await fetch(host + "/ipg/v1x/c2bPayment/singleStage/", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        Origin: Deno.env.get("MPESA_ORIGIN") ?? "developer.mpesa.vm.co.mz",
      },
      body: JSON.stringify({
        input_TransactionReference: ref,
        input_CustomerMSISDN: String(phone),
        input_Amount: String(mzn),
        input_ThirdPartyReference: ref,
        input_ServiceProviderCode: Deno.env.get("MPESA_SERVICE_PROVIDER_CODE")!,
      }),
    }).finally(() => clearTimeout(to));
    const j = await r.json().catch(() => ({}));

    // 5) só credita se o M-Pesa confirmar
    if (j.output_ResponseCode === "INS-0") {
      await admin.rpc("bengu_deposit_confirm", { p_id: depositId, p_ref: j.output_TransactionID ?? ref });
      return json({ ok: true });
    }
    await admin.rpc("bengu_deposit_fail", { p_id: depositId, p_error: `${j.output_ResponseCode ?? ""} ${j.output_ResponseDesc ?? ""}`.trim() });
    return json({ ok: false, error: j.output_ResponseDesc || "O M-Pesa não confirmou o pagamento." });
  } catch (_e) {
    // sem confirmação clara: o depósito fica pendente e NÃO credita saldo
    return json({ ok: false, error: "Não recebemos a confirmação do M-Pesa. O saldo só aumenta quando o pagamento for confirmado." }, 504);
  }
});
