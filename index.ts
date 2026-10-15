// BENGU 4.9.4 · Supabase Edge Function "sync-fixtures"
// Vai buscar os jogos de futebol à API-Football e guarda-os na tabela sports_fixtures.
// Segredos necessários: APIFOOTBALL_KEY, SYNC_SECRET (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem).
// Desligue "Verify JWT" ao criar a função (a protecção é o cabeçalho x-sync-secret).
const API = "https://v3.football.api-sports.io";
const SB = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("APIFOOTBALL_KEY")!;
const SECRET = Deno.env.get("SYNC_SECRET")!;
const day = (o: number) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
const sbHead = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };

async function syncDay(d: string) {
  const r = await fetch(`${API}/fixtures?date=${d}`, { headers: { "x-apisports-key": KEY } });
  const j = await r.json().catch(() => ({}));
  const errs = j.errors && !Array.isArray(j.errors) ? Object.values(j.errors) : [];
  if (!r.ok || errs.length) return { date: d, saved: 0, error: errs.join("; ") || `HTTP ${r.status}` };
  const now = new Date().toISOString();
  const rows = (j.response || []).map((x: any) => ({
    sport: "football",
    ext_id: x.fixture.id,
    league: x.league?.name ?? null,
    country: x.league?.country ?? null,
    home: x.teams?.home?.name ?? null,
    away: x.teams?.away?.name ?? null,
    home_score: x.goals?.home ?? null,
    away_score: x.goals?.away ?? null,
    status: x.fixture.status?.short ?? null,
    kickoff: x.fixture.date,
    updated_at: now,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${SB}/rest/v1/sports_fixtures?on_conflict=sport,ext_id`, {
      method: "POST",
      headers: { ...sbHead, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!res.ok) return { date: d, saved: i, error: await res.text() };
  }
  return { date: d, saved: rows.length };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== SECRET) return new Response("unauthorized", { status: 401 });
  const mode = new URL(req.url).searchParams.get("mode") || "today";
  const days = mode === "window" ? [-4, -3, -2, -1, 1, 2, 3, 4] : [0];
  const out = [];
  for (const o of days) out.push(await syncDay(day(o)));
  if (mode === "window") {
    const old = new Date(Date.now() - 14 * 864e5).toISOString();
    await fetch(`${SB}/rest/v1/sports_fixtures?kickoff=lt.${old}`, { method: "DELETE", headers: sbHead });
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
