// Supabase Edge Function: paypal-payout
// Pays a Bengu withdrawal request (method "paypal") through the PayPal Payouts API.
// Called by the admin panel: POST { id: <withdrawal id> } with the admin's JWT.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PP = Deno.env.get("PAYPAL_ENV") === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";
const MAX_USD = Number(Deno.env.get("PAYPAL_MAX_USD") || "50"); // safety cap per payout

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const rpc = (name: string, body: unknown = {}) =>
      fetch(`${SB}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const { id } = await req.json();
    if (!id) return json({ ok: false, error: "Missing id" }, 400);

    // Admin check: this RPC only works for admins (same one the admin panel uses).
    const lr = await rpc("bengu_admin_withdrawals");
    if (!lr.ok) return json({ ok: false, error: "Admin only" }, 403);
    const list = await lr.json();
    const w = (list || []).find((x: any) => String(x.id) === String(id));
    if (!w) return json({ ok: false, error: "Request not found" }, 404);

    if (w.method !== "paypal") return json({ ok: false, error: "Not a PayPal request" }, 400);
    if (!["pending", "approved"].includes(w.status)) return json({ ok: false, error: "Already " + w.status }, 409);

    const email = String(w.account || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Invalid PayPal e-mail" }, 400);
    const amount = Number(w.amount_usd);
    if (!(amount > 0)) return json({ ok: false, error: "Invalid amount" }, 400);
    if (amount > MAX_USD) return json({ ok: false, error: `Above the safety cap of US$${MAX_USD}. Pay it manually.` }, 400);

    // PayPal access token
    const basic = btoa(`${Deno.env.get("PAYPAL_CLIENT_ID")}:${Deno.env.get("PAYPAL_SECRET")}`);
    const tr = await fetch(`${PP}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!tr.ok) return json({ ok: false, error: "PayPal login failed. Check PAYPAL_CLIENT_ID / PAYPAL_SECRET." }, 502);
    const { access_token } = await tr.json();
    const ppHead = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

    // The same request id is never paid twice (PayPal returns the original result).
    const reqId = `bengu-wd-${w.id}`;
    const pr = await fetch(`${PP}/v1/payments/payouts`, {
      method: "POST",
      headers: { ...ppHead, "PayPal-Request-Id": reqId },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: reqId,
          email_subject: "Your Bengu earnings",
          email_message: "Your Bengu earnings withdrawal has been sent.",
        },
        items: [{
          recipient_type: "EMAIL",
          receiver: email,
          amount: { value: amount.toFixed(2), currency: "USD" },
          note: "Bengu earnings",
          sender_item_id: String(w.id),
        }],
      }),
    });
    const pj = await pr.json().catch(() => ({}));
    if (!pr.ok) return json({ ok: false, error: pj.message || pj.name || `PayPal error ${pr.status}` }, 502);

    const batch = pj.batch_header?.payout_batch_id as string;
    let status = pj.batch_header?.batch_status as string;

    // PayPal is asynchronous: check a few times, mark Paid only on SUCCESS.
    for (let i = 0; i < 3 && status !== "SUCCESS" && status !== "DENIED"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const gr = await fetch(`${PP}/v1/payments/payouts/${batch}`, { headers: ppHead });
      if (gr.ok) status = (await gr.json()).batch_header?.batch_status || status;
    }

    const final = status === "SUCCESS" ? "paid" : status === "DENIED" ? "pending" : "approved";
    const sr = await rpc("bengu_admin_set_withdrawal", {
      p_id: w.id, p_status: final, p_note: `PayPal batch ${batch} (${status})`,
    });
    return json({ ok: status !== "DENIED", batch_id: batch, paypal_status: status, marked: final, db_ok: sr.ok });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
